/**
 * Talking to the server. Every call goes through here so a lapsed session is
 * handled in one place — sent back to sign in — rather than as a scatter of
 * confusing errors across the page.
 */

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
    throw new ApiError("Cannot reach the server", 0);
  }
  return handle(res);
}

export async function send(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Cannot reach the server — the change was not saved", 0);
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
