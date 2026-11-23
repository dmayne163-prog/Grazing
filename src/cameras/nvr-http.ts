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

/** The NVR's recorded clips on a channel between two local times ("YYYY-MM-DD HH:MM:SS"), oldest first. */
export async function findClips(channel: number, from: string, to: string): Promise<Array<{ start: string; end: string }>> {
  const made = await nvrGet("/cgi-bin/mediaFileFind.cgi?action=factory.create");
  const obj = /result=(\d+)/.exec(made.text)?.[1];
  if (made.status !== 200 || !obj) throw new Error(`The NVR wouldn't search its recordings (HTTP ${made.status})`);
  const q = (v: string) => encodeURIComponent(v);
  try {
    const f = await nvrGet(`/cgi-bin/mediaFileFind.cgi?action=findFile&object=${obj}&condition.Channel=${channel}&condition.StartTime=${q(from)}&condition.EndTime=${q(to)}`);
    if (f.status !== 200) return []; // nothing recorded in that window
    const out: Array<{ start: string; end: string }> = [];
    for (let page = 0; page < 20; page++) {
      const n = await nvrGet(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${obj}&count=100`);
      const found = Number(/found=(\d+)/.exec(n.text)?.[1] ?? 0);
      if (!found) break;
      const items = new Map<string, { start?: string; end?: string }>();
      for (const m of n.text.matchAll(/items\[(\d+)\]\.(StartTime|EndTime)=([^\r\n]+)/g)) {
        const it = items.get(m[1]!) ?? {};
        if (m[2] === "StartTime") it.start = m[3]!.trim(); else it.end = m[3]!.trim();
        items.set(m[1]!, it);
      }
      for (const it of items.values()) if (it.start && it.end) out.push({ start: it.start, end: it.end });
      if (found < 100) break;
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  } finally {
    await nvrGet(`/cgi-bin/mediaFileFind.cgi?action=close&object=${obj}`).catch(() => undefined);
    await nvrGet(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${obj}`).catch(() => undefined);
  }
}
