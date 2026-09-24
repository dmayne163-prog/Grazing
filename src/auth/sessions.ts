import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import {
  createSession, deleteSession, getSession, getUserById, touchSession,
  type Role, type UserRow,
} from "../db/database.js";

export const COOKIE_NAME = "gz_session";

/** Sessions last this long; sliding, refreshed on use. */
const SESSION_DAYS = Math.max(1, config.sessionDays);
const SESSION_MS = SESSION_DAYS * 86_400_000;

/** Refresh the expiry at most once a day, to avoid a write on every request. */
const REFRESH_AFTER_MS = 86_400_000;

export interface AuthedUser {
  id: number;
  username: string;
  role: Role;
}

/**
 * Cookies are parsed by hand rather than pulling in a dependency — one header,
 * one split, and no supply chain.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Same parsing for the WebSocket upgrade, which is not an Express request. */
export function readCookieFromHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function issueSession(res: Response, user: UserRow, secure: boolean, label: string | null) {
  // 32 random bytes; guessing one is not a realistic attack.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_MS;
  createSession(token, user.id, expiresAt, label);

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,          // not readable from JavaScript, so XSS cannot lift it
    sameSite: "lax",         // survives following a link in, blocks cross-site POSTs
    secure,                  // only over HTTPS when the request arrived that way
    maxAge: SESSION_MS,
    path: "/",
  });
  return token;
}

export function clearSession(res: Response, token: string | null, secure: boolean) {
  if (token) deleteSession(token);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure, path: "/" });
}

/** Resolves a session token to a user, refreshing a sliding expiry as it goes. */
export function userForToken(token: string | null): AuthedUser | null {
  if (!token) return null;
  const session = getSession(token);
  if (!session) return null;

  if (session.expires_at < Date.now()) {
    deleteSession(token);
    return null;
  }

  const user = getUserById(session.user_id);
  if (!user) {
    deleteSession(token);
    return null;
  }

  const remaining = session.expires_at - Date.now();
  if (SESSION_MS - remaining > REFRESH_AFTER_MS) {
    touchSession(token, Date.now() + SESSION_MS);
  }

  return { id: user.id, username: user.username, role: user.role };
}

/**
 * Whether the cookie should be marked Secure.
 *
 * The app is reachable both over HTTPS through the Cloudflare tunnel and
 * over plain HTTP on the LAN. Marking the cookie Secure unconditionally would
 * break the LAN route entirely, so it follows how the request actually arrived.
 */
export function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers["x-forwarded-proto"];
  const value = Array.isArray(proto) ? proto[0] : proto;
  return typeof value === "string" && value.split(",")[0]?.trim() === "https";
}

export const authConfig = { sessionDays: SESSION_DAYS, requireAuth: config.requireAuth };
