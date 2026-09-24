/**
 * Service worker: keeps the app usable out of signal.
 *
 *  - QLD imagery tiles are kept indefinitely once seen (or once saved with
 *    "Save map for offline"). Their cache is not versioned, so an app update
 *    does not throw away hundreds of megabytes of imagery.
 *  - The app's own code is fetched fresh whenever the server answers, so an
 *    update takes effect on the next load, and falls back to the cached copy
 *    out of signal. The map libraries rarely change and are served from cache.
 *  - The map data (paddocks, water points) is fetched fresh when possible and
 *    falls back to the last copy when not.
 *  - Esri imagery is never stored; its terms do not allow an offline copy.
 *  - Nothing else is cached. Every change is sent to the server live.
 */

const STATIC = "static-v1";
const DATA = "data-v1";
const TILES = "tiles-qld";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC, DATA, TILES]);
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
  } else if (path === "/api/meta" || path === "/api/features") {
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
    const res = await fetch(req);
    // Only good answers are kept. A sign-in page or an error must not replace
    // the last working copy of the map.
    if (res.ok && !res.redirected) await cache.put(key || req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(key || req);
    if (hit) return hit;
    throw e;
  }
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
