import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { countUsers } from "../db/database.js";
import { COOKIE_NAME, readCookie, userForToken, type AuthedUser } from "./sessions.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/**
 * Attaches the logged-in user to the request, if there is one. Never rejects —
 * that is the job of the guards below, so unauthenticated routes (login, setup)
 * can still see whether someone is already signed in.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE_NAME);
  const user = userForToken(token);
  if (user) req.user = user;
  next();
}

/** True while no account exists yet, so the first admin can be created. */
export function needsSetup(): boolean {
  return countUsers() === 0;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.requireAuth) return next();
  if (needsSetup()) {
    res.status(409).json({ error: "No account exists yet", setupRequired: true });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}

/**
 * Admin-only. Viewers get a 403 with a clear reason rather than a bare refusal,
 * so the dashboard can explain why a control is unavailable instead of looking
 * broken.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.requireAuth) return next();
  if (!req.user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({
      error: "This account is read-only. An administrator can change the map and records.",
      role: req.user.role,
    });
    return;
  }
  next();
}
