/**
 * Cloudflare Access verification.
 *
 * Access authenticates people at Cloudflare's edge and forwards a signed JWT
 * in `Cf-Access-Jwt-Assertion`. Checking that signature here is what makes the
 * edge a real boundary rather than a suggestion: without it, anything that can
 * reach the container's port — a mistyped firewall rule, another container, a
 * second tunnel pointed at the same origin — walks straight past Access to the
 * login page.
 *
 * The token is verified, not merely read. An unverified `Cf-Access-*` header is
 * worth nothing, because a header is exactly what an attacker would forge.
 *
 * Signatures are checked with Node's own crypto against the team's published
 * JWKS, so this needs no JWT dependency.
 */
import { createPublicKey, createHash, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { isLanRequest, isPrivateAddress, viaCloudflare } from "../net/client.js";
import { logger } from "../logger.js";

const log = logger("cf-access");

export interface AccessIdentity {
  /** Set for a human signing in through an identity provider. */
  email: string | null;
  /** Cloudflare's stable user id. */
  sub: string | null;
  /** Set instead of an email when a service token was used. */
  commonName: string | null;
}

interface Jwk {
  kid?: string; kty?: string; alg?: string; n?: string; e?: string;
}

/* ------------------------------ key material ----------------------------- */

const CERTS_TTL_MS = 60 * 60_000;
/** Never re-fetch faster than this, so an unknown kid cannot be a DoS lever. */
const CERTS_MIN_INTERVAL_MS = 60_000;

let keys = new Map<string, KeyObject>();
let keysFetchedAt = 0;
let inFlight: Promise<void> | null = null;

function teamBase(): string | null {
  const raw = config.cfAccessTeamDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!raw) return null;
  // Accept either "myteam" or the full "myteam.cloudflareaccess.com".
  return raw.includes(".") ? `https://${raw}` : `https://${raw}.cloudflareaccess.com`;
}

export function accessConfigured(): boolean {
  return teamBase() !== null && config.cfAccessAud.trim() !== "";
}

async function refreshKeys(force: boolean): Promise<void> {
  const base = teamBase();
  if (!base) return;

  const age = Date.now() - keysFetchedAt;
  if (!force && age < CERTS_TTL_MS && keys.size > 0) return;
  if (force && age < CERTS_MIN_INTERVAL_MS) return;

  if (inFlight) return inFlight;
  inFlight = (async () => {
    const url = `${base}/cdn-cgi/access/certs`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };

    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
      } catch (e) {
        log.warn(`ignoring unusable Access key ${jwk.kid}: ${String(e)}`);
      }
    }
    if (next.size === 0) throw new Error("Access published no usable RSA keys");

    keys = next;
    keysFetchedAt = Date.now();
    log.debug(`loaded ${keys.size} Access signing key(s)`);
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/** Warms the key cache at startup so the first visitor is not the one who waits. */
export async function initAccess(): Promise<void> {
  if (!accessConfigured()) return;
  try {
    await refreshKeys(false);
    log.info(`Cloudflare Access enforced for ${teamBase()} (aud ${shortAud()})`);
  } catch (e) {
    log.error(
      "could not load Cloudflare Access keys — tunnelled requests will be refused " +
      `until this succeeds: ${String(e)}`
    );
  }
}

function shortAud(): string {
  const aud = config.cfAccessAud.trim();
  return aud.length > 12 ? `${aud.slice(0, 8)}...${aud.slice(-4)}` : aud;
}

/* -------------------------------- decoding ------------------------------- */

function b64url(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface Claims {
  aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; iat?: unknown;
  email?: unknown; sub?: unknown; common_name?: unknown;
}

/**
 * Returns the verified identity, or null for any token that fails a check.
 * Deliberately gives no reason back to the caller — the log has the detail,
 * the response does not.
 */
export async function verifyAccessJwt(token: string): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  let head: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    head = JSON.parse(b64url(rawHeader).toString("utf8"));
    claims = JSON.parse(b64url(rawPayload).toString("utf8"));
  } catch {
    return null;
  }

  // Only RS256. Accepting "none", or letting the token choose its own
  // algorithm, is the classic way JWT verification is defeated.
  if (head.alg !== "RS256" || !head.kid) {
    log.warn(`rejected Access token with alg=${String(head.alg)}`);
    return null;
  }

  try {
    await refreshKeys(false);
    if (!keys.has(head.kid)) await refreshKeys(true); // key rotation
  } catch (e) {
    log.error(`Access key fetch failed: ${String(e)}`);
    return null;
  }

  const key = keys.get(head.kid);
  if (!key) {
    log.warn(`Access token signed with unknown key ${head.kid}`);
    return null;
  }

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
  if (!cryptoVerify("RSA-SHA256", signed, key, b64url(rawSig))) {
    log.warn("Access token signature did not verify");
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const skew = 60;

  if (typeof claims.exp !== "number" || claims.exp + skew < nowSec) {
    log.warn("Access token has expired");
    return null;
  }
  if (typeof claims.nbf === "number" && claims.nbf - skew > nowSec) return null;

  const expectedIss = teamBase();
  if (typeof claims.iss !== "string" || claims.iss.replace(/\/+$/, "") !== expectedIss) {
    log.warn(`Access token issuer ${String(claims.iss)} is not ${expectedIss}`);
    return null;
  }

  // aud pins the token to *this* Access application. Without it, a token
  // minted for any other app on the same team would be accepted here.
  const wanted = config.cfAccessAud.trim();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && a === wanted)) {
    log.warn("Access token audience does not match CF_ACCESS_AUD");
    return null;
  }

  return {
    email: typeof claims.email === "string" ? claims.email : null,
    sub: typeof claims.sub === "string" ? claims.sub : null,
    commonName: typeof claims.common_name === "string" ? claims.common_name : null,
  };
}

/** Access sends the assertion as a header, and as a cookie on browser routes. */
export function accessTokenFrom(req: Request): string | null {
  const h = req.headers["cf-access-jwt-assertion"];
  const s = Array.isArray(h) ? h[0] : h;
  if (typeof s === "string" && s !== "") return s;

  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== "CF_Authorization") continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/* ------------------------------- middleware ------------------------------ */

/**
 * Refuses any request from outside the LAN that has not been through Access.
 *
 * LAN callers are exempt so the dashboard keeps working on the property when
 * the internet is down — which, for a system whose whole premise is surviving
 * an outage, is not a detail. Tunnelled requests must present a valid token,
 * and fail closed if the keys cannot be checked.
 */
export async function requireAccess(req: Request, res: Response, next: NextFunction) {
  if (!config.cfAccessRequired) return next();
  if (isLanRequest(req)) return next();

  if (!accessConfigured()) {
    log.error("CF_ACCESS_REQUIRED is on but CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD are not set");
    res.status(503).json({ error: "Remote access is not configured" });
    return;
  }

  const token = accessTokenFrom(req);
  if (!token) {
    log.warn(`refused a request carrying no Access token (cloudflare=${viaCloudflare(req)})`);
    res.status(403).json({ error: "This app is reached through Cloudflare Access" });
    return;
  }

  const identity = await verifyAccessJwt(token);
  if (!identity) {
    res.status(403).json({ error: "Cloudflare Access verification failed" });
    return;
  }

  req.accessIdentity = identity;
  next();
}

/**
 * The same check for a WebSocket upgrade.
 *
 * An upgrade never touches the Express middleware chain, so without this the
 * socket would be the one door in the building that Access does not cover —
 * and it carries the identical live data the REST API does.
 *
 * It works from the raw request because there is no Express `req.ip` here:
 * the peer address plus Cloudflare's own markers are enough to tell a LAN
 * client from a tunnelled one.
 */
export async function accessAllowsUpgrade(req: IncomingMessage): Promise<boolean> {
  if (!config.cfAccessRequired) return true;

  const peer = req.socket.remoteAddress ?? "";
  const cfRay = req.headers["cf-ray"];
  const cfIp = req.headers["cf-connecting-ip"];
  const tunnelled = cfRay !== undefined || cfIp !== undefined;
  if (!tunnelled && isPrivateAddress(peer)) return true;

  if (!accessConfigured()) {
    log.error("CF_ACCESS_REQUIRED is on but Access is not configured — refusing the socket");
    return false;
  }

  const header = req.headers["cf-access-jwt-assertion"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const token = (typeof fromHeader === "string" && fromHeader !== "")
    ? fromHeader
    : cookieValue(req.headers.cookie, "CF_Authorization");

  if (!token) {
    log.warn("refused a WebSocket upgrade carrying no Access token");
    return false;
  }
  return (await verifyAccessJwt(token)) !== null;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** A short, non-reversible tag for the log, so identities are not written out. */
export function identityTag(id: AccessIdentity): string {
  const who = id.email ?? id.commonName ?? id.sub ?? "unknown";
  return createHash("sha256").update(who).digest("hex").slice(0, 8);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accessIdentity?: AccessIdentity;
    }
  }
}
