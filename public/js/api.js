/**
 * Talking to the server. Every call goes through here so a lapsed session is
 * handled in one place — sent back to sign in — rather than as a scatter of
 * confusing errors across the page.
 */

import { add as queueChange, flush, list as queued, newId } from "./outbox.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function handle(res) {
  if (res.status === 401) {
    location.href = "/";
    throw new ApiError("Signed out", 401);
  }
  let body = null;
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError((body && body.error) || `The server said ${res.status}`, res.status);
  }
  return body;
}

export async function get(path) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError("Not available offline — open it once with signal to keep a copy", 0);
  }
  // Out of signal the service worker answers with the last copy it kept, and
  // says when that was.
  const copy = res.headers.get("X-Offline-Copy");
  if (copy) window.dispatchEvent(new CustomEvent("offline-copy", { detail: { at: Number(copy) } }));
  else if (res.ok) window.dispatchEvent(new CustomEvent("fresh-data"));
  return handle(res);
}

/**
 * Makes a change. With `queue` (a description for the user), a change that
 * can't reach the server is kept on the phone and sent later, and this
 * resolves with `{ queued: true }`. While earlier changes are still waiting,
 * new ones queue behind them so they reach the server in the order made.
 */
export async function send(method, path, body, { queue = null } = {}) {
  if (queue && (await queued()).some((i) => i.status === "waiting")) {
    await queueChange(method, path, body, queue);
    flush();
    return { queued: true, batch: "queued" };
  }
  // The same id goes with it if it has to be sent again, so the server
  // can tell a repeat from a new change.
  const id = queue ? newId() : null;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(id ? { "X-Offline-Id": id } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (queue) {
      await queueChange(method, path, body, queue, id);
      flush();
      return { queued: true, batch: "queued" };
    }
    throw new ApiError("Cannot reach the server — the change was not saved. This one can't be done offline.", 0);
  }
  return handle(res);
}

export async function upload(path, file) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
        Accept: "application/json",
      },
      body: file,
    });
  } catch {
    throw new ApiError("Cannot reach the server", 0);
  }
  return handle(res);
}
