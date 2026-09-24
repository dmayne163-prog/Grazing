/**
 * Where a request actually came from.
 *
 * Once the app is published through a Cloudflare tunnel there are two
 * very different kinds of caller — someone on the property's LAN, and someone
 * on the internet — and several security decisions turn on telling them apart:
 * rate-limit buckets, whether Cloudflare Access is mandatory, whether the
 * first-run setup page may be served.
 *
 * Everything here is derived from headers, which are forgeable by anyone we
 * have not decided to trust. That is why `trust proxy` is narrowed in index.ts
 * rather than left at `true`: Express only populates `req.ip` from
 * X-Forwarded-For when the immediate peer is a trusted address, so a stranger
 * cannot claim to be on the LAN just by setting a header.
 */
import type { Request } from "express";

/** Strips the IPv4-mapped IPv6 prefix Node reports for dual-stack sockets. */
export function normaliseIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (v.startsWith("::ffff:")) return v.slice(7);
  return v;
}

/**
 * RFC 1918 and friends — the address ranges that can only be reached from
 * inside the network, so a caller holding one is on the LAN.
 */
export function isPrivateAddress(raw: string): boolean {
  const ip = normaliseIp(raw);
  if (ip === "" || ip === "::1" || ip === "localhost") return true;

  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;   // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT, used by Tailscale
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd]/.test(ip)) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  return false;
}

/**
 * The caller's address, as well as we can know it.
 *
 * Cloudflare puts the true client address in CF-Connecting-IP, which is more
 * trustworthy than the X-Forwarded-For chain because Cloudflare overwrites it
 * at the edge rather than appending to it. It is only honoured when the
 * immediate peer is trusted — otherwise anyone on the LAN could set it.
 */
export function clientIp(req: Request): string {
  const peerTrusted = isPeerTrusted(req);
  if (peerTrusted) {
    const cf = header(req, "cf-connecting-ip");
    if (cf) return normaliseIp(cf);
  }
  return normaliseIp(req.ip ?? req.socket.remoteAddress ?? "");
}

/**
 * Whether the machine we are actually talking to is one Express was told to
 * trust. `req.ips` is only populated for a trusted peer, and for a direct
 * connection `req.ip` equals the socket address.
 */
function isPeerTrusted(req: Request): boolean {
  const peer = normaliseIp(req.socket.remoteAddress ?? "");
  if (peer === "") return false;
  // If Express rewrote req.ip away from the socket address, it trusted the peer.
  if (normaliseIp(req.ip ?? "") !== peer) return true;
  return req.ips.length > 0;
}

export function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s !== "" ? s : null;
}

/** True when the request bears Cloudflare's edge markers. */
export function viaCloudflare(req: Request): boolean {
  return header(req, "cf-ray") !== null || header(req, "cf-connecting-ip") !== null;
}

/**
 * A request we are willing to treat as coming from inside the property.
 *
 * Anything carrying Cloudflare's markers is from the internet by definition,
 * however private the socket address looks — cloudflared runs on the same
 * Docker host, so the peer address alone would say "LAN" for every tunnelled
 * request and quietly disable the protections that matter most.
 */
export function isLanRequest(req: Request): boolean {
  if (viaCloudflare(req)) return false;
  return isPrivateAddress(clientIp(req));
}
