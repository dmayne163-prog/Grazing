/**
 * Service worker: keeps the app usable out of signal.
 *
 *  - QLD imagery tiles are kept indefinitely once seen (or once saved with
 *    "Save map for offline"). Their cache is not versioned, so an app update
 *    does not throw away hundreds of megabytes of imagery.
 *  - The app's own code is fetched fresh whenever the server answers, so an
 *    update takes effect on the next load, and falls back to the cached copy
 *    out of signal. The map libraries rarely change and are served from cache.
 *  - Everything the app reads from the server (map, mobs, gates, animals,
 *    rain, notes…) is fetched fresh when possible and falls back to the last
 *    copy when not. That copy is marked with when it was kept (X-Offline-Copy)
 *    so the app can say how old what it's showing is.
 *  - Photos on notes never change, so once seen they're served from the phone.
 *  - Esri imagery is never stored; its terms do not allow an offline copy.
 *  - Changes are never cached here: out of signal the app keeps them in its
 *    own outbox (outbox.js) and sends them when it can.
 */

// Bumped when the caching rules change, so phones drop copies kept under the old ones.
const STATIC = "static-v3";
const DATA = "data-v2";
const PHOTOS = "photos-v1";
const TILES = "tiles-qld";

/**
 * The app itself, kept as soon as this service worker installs, so the app
 * opens out of signal even if it has only ever been opened once. Listed by
 * hand: a new script file has to be added here too.
 */
const SHELL = [
  "/styles.css", "/manifest.webmanifest", "/icons/icon.svg",
  "/vendor/leaflet/leaflet.css", "/vendor/leaflet/leaflet.js", "/vendor/geoman/leaflet-geoman.css", "/vendor/geoman/leaflet-geoman.min.js",
  ...["animalui", "api", "editor", "gatefinder", "importer", "main", "map", "moblayer", "nlischeck", "notes",
    "offline", "optiweighui", "outbox", "pasture", "plan", "rain", "register", "reports", "ruminati",
    "stockui", "users"].map((n) => `/js/${n}.js`),
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC);
    await Promise.all(SHELL.map(async (u) => {
      try {
        const res = await fetch(u, { cache: "no-cache" });
        if (res.ok && !res.redirected) await cache.put(u, res);
      } catch { /* kept the first time it's used instead */ }
    }));
    // The page itself, under the key every navigation shares.
    try {
      const page = await fetch("/", { cache: "no-cache" });
      if (page.ok && !page.redirected) await (await caches.open(DATA)).put("/", await stamped(page));
    } catch { /* likewise */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC, DATA, TILES, PHOTOS]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (path.startsWith("/tiles/qld/")) {
    event.respondWith(cacheFirst(req, TILES));
  } else if (/^\/api\/notes\/\d+\/photo$/.test(path)) {
    event.respondWith(cacheFirst(req, PHOTOS));
  } else if (path.startsWith("/api/") && !NOT_KEPT.test(path)) {
    event.respondWith(networkFirst(req, DATA));
  } else if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, DATA, "/"));
  } else if (path.startsWith("/js/") || path === "/styles.css") {
    event.respondWith(networkFirst(req, STATIC));
  } else if (
    path.startsWith("/vendor/") || path.startsWith("/icons/") || path === "/manifest.webmanifest"
  ) {
    event.respondWith(staleWhileRevalidate(req, STATIC));
  }
});

/** Reads not worth keeping a copy of: downloads, exports and the health check. */
const NOT_KEPT = /^\/api\/(health|backup|backups|export|auth\/(?!me$))/;

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

/** `key` lets every page navigation share one cached copy of the app shell. */
async function networkFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    // Straight past the browser's own HTTP cache to the server, so an update
    // shows on the next load. Out of signal this throws and the copy below is used.
    // (A navigation request can't take options; the page itself is sent no-store.)
    const res = await (req.mode === "navigate" ? fetch(req) : fetch(req, { cache: "no-cache" }));
    // Only good answers are kept. A sign-in page or an error must not replace
    // the last working copy of the map.
    if (res.ok && !res.redirected) await cache.put(key || req, await stamped(res.clone()));
    return res;
  } catch (e) {
    const hit = await cache.match(key || req);
    if (hit) return offlineCopy(hit);
    throw e;
  }
}

/** The response as kept, with when it was kept. */
async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set("X-Kept-At", String(Date.now()));
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

/** A kept copy handed out in place of the server's answer, marked as such. */
async function offlineCopy(hit) {
  const at = hit.headers.get("X-Kept-At");
  if (!at) return hit;
  const headers = new Headers(hit.headers);
  headers.set("X-Offline-Copy", at);
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await fresh) || Response.error();
}
