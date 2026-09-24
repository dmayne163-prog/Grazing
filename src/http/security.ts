/**
 * Response hardening and cross-site request defence.
 *
 * On a LAN these headers were close to decoration. Published through a tunnel
 * they are the difference between "one XSS bug" and "one XSS bug that reads
 * every paddock, every record and every session", so they are set for every
 * response rather than only the HTML ones.
 */
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { isSecureRequest } from "../auth/sessions.js";
import { logger } from "../logger.js";

const log = logger("security");

/**
 * The policy is strict because the app earns it: every script, style and font
 * it uses is served from this origin — the map libraries from node_modules,
 * and the imagery tiles through this server's own tile cache. There is no CDN,
 * no analytics and no embedded widget, so nothing here needs 'unsafe-inline'
 * or a host allowlist.
 *
 * `data:` survives in img-src because the favicon and the map editor's tool
 * icons are inline SVG.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  // Same-origin XHR and the /ws socket. CSP level 3 counts a same-origin
  // ws:// or wss:// as 'self', so the socket needs no separate entry.
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

const CSP = CSP_DIRECTIVES.join("; ");

/** One year, and deliberately without preload — see the note below. */
const HSTS = "max-age=31536000; includeSubDomains";

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    // Geolocation is allowed for this origin only: "where am I" on the map is
    // how a paddock is found from the ute. Nothing else may ask for it.
    "camera=(), microphone=(), geolocation=(self), payment=(), usb=(), interest-cohort=()"
  );

  // HSTS only on a request that actually arrived over HTTPS. Sending it on the
  // plain-HTTP LAN route would pin the browser to HTTPS for this host and lock
  // the dashboard out on the property, where there is no certificate. No
  // preload for the same reason: it is not reversible in any useful timeframe.
  if (isSecureRequest(req)) {
    res.setHeader("Strict-Transport-Security", HSTS);
  }

  next();
}

/* -------------------------------- caching -------------------------------- */

/**
 * Forbids caching of anything whose content depends on who is asking.
 *
 * Two kinds of response need this. Every `/api` response is per-session by
 * definition. And `/` is worse than it looks: it serves the login page or the
 * dashboard shell depending on the session cookie, under one URL, so a cached
 * copy can be the wrong document entirely.
 *
 * Left alone, Express marked both with an ETag and `public, max-age=0`. That
 * produced a redirect loop through the tunnel — a cached `/` insisting the
 * visitor was signed out while a live `/api/auth/me` said otherwise, each
 * sending the browser back to the other several times a second.
 *
 * `public` was the more serious half. It invites a shared cache to store a
 * session-dependent page and hand it to somebody else.
 *
 * Static assets are deliberately not covered: app.js and styles.css are the
 * same for everyone, and revalidating them with an ETag is exactly right.
 */
export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

/* ------------------------------ CSRF defence ----------------------------- */

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function expectedHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const host = req.headers.host;
  if (typeof host === "string" && host !== "") hosts.add(host.toLowerCase());

  const forwarded = req.headers["x-forwarded-host"];
  const fwd = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof fwd === "string") {
    for (const h of fwd.split(",")) {
      const v = h.trim().toLowerCase();
      if (v) hosts.add(v);
    }
  }

  for (const extra of config.trustedOrigins) {
    try {
      hosts.add(new URL(extra).host.toLowerCase());
    } catch {
      hosts.add(extra.toLowerCase());
    }
  }
  return hosts;
}

/**
 * Blocks state-changing requests issued by another site.
 *
 * The session cookie is already SameSite=Lax, which stops a cross-site form
 * POST on its own. This is the second lock: SameSite is enforced by the
 * browser and only by the browser, and the actions behind it — rewriting
 * the map, creating accounts, deleting records — are worth checking twice.
 *
 * A request carrying neither Sec-Fetch-Site nor Origin is not a browser
 * request at all (curl, a script, a health probe), and cannot be a cross-site
 * attack, so it passes. Every browser in current use sends at least one.
 */
export function blockCrossSite(req: Request, res: Response, next: NextFunction) {
  if (!UNSAFE.has(req.method)) return next();

  const fetchSite = req.headers["sec-fetch-site"];
  const site = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;

  if (typeof site === "string" && site !== "") {
    // "none" is a user-initiated load — typed, bookmarked, a PWA launch.
    if (site === "same-origin" || site === "none") return next();
    log.warn(`blocked ${req.method} ${req.path} from Sec-Fetch-Site: ${site}`);
    res.status(403).json({ error: "Cross-site requests are not accepted" });
    return;
  }

  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (typeof origin === "string" && origin !== "" && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      res.status(403).json({ error: "Cross-site requests are not accepted" });
      return;
    }
    if (expectedHosts(req).has(originHost)) return next();
    log.warn(`blocked ${req.method} ${req.path} from origin ${origin}`);
    res.status(403).json({ error: "Cross-site requests are not accepted" });
    return;
  }

  next();
}
