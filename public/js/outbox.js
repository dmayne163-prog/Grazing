/**
 * The outbox: changes made out of signal, kept on the phone (IndexedDB) until
 * they can be sent.
 *
 * Each change is stamped with the date and time it was made, so a move
 * recorded at 7 am out in the paddock is recorded at 7 am, not when the phone
 * next finds signal. Each also carries an id made here: the server keeps the
 * answer to every id it has seen, so a change whose reply was lost in a
 * patchy signal is never saved twice when it is sent again.
 *
 * Changes are sent in the order they were made, oldest first, whenever the
 * phone is back online, the app is opened, or every half-minute while any
 * are waiting. (Firefox on Android has no background sending: the app has
 * to be open for the queue to go.) One the server turns down — say the mob
 * was merged in the meantime — is kept, marked with the reason, for the user
 * to look at and discard.
 */

const DB = "grazing-offline";
const STORE = "outbox";
const listeners = new Set();
let dbp = null;
let flushing = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const pad = (n) => String(n).padStart(2, "0");
export function localNow() {
  const d = new Date();
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Every waiting change, oldest first. */
export async function list() {
  try {
    const all = await tx("readonly", (s) => s.getAll());
    return (all || []).sort((a, b) => a.created - b.created);
  } catch {
    return [];
  }
}

/**
 * Keeps a change to send later. `label` is what the user sees ("Moved Red
 * Tag heifers to No.2"). A change without a date gets now, here.
 */
export async function add(method, path, body, label, id = newId()) {
  const stamped = body && typeof body === "object" && !Array.isArray(body) && !body.date ? { ...body, ...localNow() } : body;
  const item = { id, method, path, body: stamped, label: label || `${method} ${path}`, created: Date.now(), status: "waiting", error: null };
  await tx("readwrite", (s) => s.put(item));
  changed();
  return item;
}

export async function remove(id) {
  await tx("readwrite", (s) => s.delete(id));
  changed();
}

async function put(item) {
  await tx("readwrite", (s) => s.put(item));
}

/** Called with the waiting list whenever it changes, and once now. */
export function onChange(fn) {
  listeners.add(fn);
  list().then(fn);
  return () => listeners.delete(fn);
}

let lastState = "idle";
/** "idle", "sending", "offline" (no signal), or "signin" (the sign-in has lapsed). */
export const syncState = () => lastState;

async function changed() {
  const items = await list();
  for (const fn of listeners) { try { fn(items, lastState); } catch { /* a listener's problem */ } }
}

/**
 * Whether a failed request means "no signal" or "Cloudflare wants you to sign
 * in again". Access answers an expired session with a redirect to its own
 * sign-in page, which a fetch sees as a network error, the same as no signal.
 */
async function signInLapsed() {
  try {
    const r = await fetch("/api/health", { redirect: "manual", cache: "no-store" });
    return r.type === "opaqueredirect" || r.status === 401 || r.status === 403;
  } catch {
    return false;
  }
}

/** Sends what's waiting, oldest first. Resolves with how many went. */
export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    const items = (await list()).filter((i) => i.status === "waiting");
    if (!items.length) { lastState = "idle"; return 0; }
    lastState = "sending";
    changed();
    for (const item of items) {
      let res;
      try {
        res = await fetch(item.path, {
          method: item.method,
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Offline-Id": item.id },
          body: item.body === undefined ? undefined : JSON.stringify(item.body),
          cache: "no-store",
        });
      } catch {
        lastState = (await signInLapsed()) ? "signin" : "offline";
        changed();
        return sent;
      }
      if (res.status === 401 || res.type === "opaqueredirect" || res.redirected) {
        lastState = "signin";
        changed();
        return sent;
      }
      if (res.ok) {
        await remove(item.id);
        sent++;
        continue;
      }
      if (res.status >= 500) {
        // The server's trouble, not the change's: try again later.
        lastState = "offline";
        changed();
        return sent;
      }
      let msg = `The server said ${res.status}`;
      try { const b = await res.json(); if (b && b.error) msg = b.error; } catch { /* not JSON */ }
      await put({ ...item, status: "failed", error: msg });
    }
    lastState = "idle";
    changed();
    if (sent) window.dispatchEvent(new CustomEvent("outbox-sent", { detail: { sent } }));
    return sent;
  })().finally(() => { flushing = null; });
  return flushing;
}

/** Sends whenever there's a chance: online again, the app shown, and every 30 s while anything waits. */
export function startSending() {
  window.addEventListener("online", () => flush());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });
  setInterval(async () => {
    if ((await list()).some((i) => i.status === "waiting")) flush();
  }, 30_000);
  flush();
}
