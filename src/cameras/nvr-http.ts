/**
 * The NVR's HTTP commands (Dahua CGI) with HTTP Digest login, which is what
 * it asks for. Used to turn a PTZ camera to a saved position (preset).
 */
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** GET a path on the NVR, answering its Digest challenge. Returns the status and body text. */
export async function nvrGet(path: string): Promise<{ status: number; text: string }> {
  const url = `http://${config.nvrHost}${path}`;
  const first = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (first.status !== 401) return { status: first.status, text: await first.text() };
  const challenge = first.headers.get("www-authenticate") ?? "";
  await first.text();
  const field = (k: string) => challenge.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? "";
  const realm = field("realm"), nonce = field("nonce"), opaque = field("opaque");
  const qop = /qop="?([^",]*)/.exec(challenge)?.[1]?.split(",")[0]?.trim() || "";
  const nc = "00000001", cnonce = randomBytes(8).toString("hex");
  const ha1 = md5(`${config.nvrUser}:${realm}:${config.nvrPass}`);
  const ha2 = md5(`GET:${path}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const auth = [
    `username="${config.nvrUser}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${path}"`, `response="${response}"`,
    ...(opaque ? [`opaque="${opaque}"`] : []), ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []), `algorithm=MD5`,
  ].join(", ");
  const r = await fetch(url, { headers: { Authorization: `Digest ${auth}` }, signal: AbortSignal.timeout(15_000) });
  return { status: r.status, text: await r.text() };
}

/** Turns a PTZ camera to one of its saved positions. */
export async function gotoPreset(channel: number, preset: number): Promise<void> {
  const r = await nvrGet(`/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=GotoPreset&arg1=0&arg2=${preset}&arg3=0`);
  if (r.status !== 200) {
    throw new Error(r.status === 403
      ? `The NVR login isn't allowed to turn channel ${channel} (tick PTZ for it on the grazingapp account)`
      : `The NVR wouldn't turn channel ${channel} to preset ${preset} (HTTP ${r.status})`);
  }
}
