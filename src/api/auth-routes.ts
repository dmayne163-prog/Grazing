import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { needsSetup, requireAdmin, requireAuth } from "../auth/middleware.js";
import {
  hashPassword, validatePassword, validateUsername, verifyPassword,
} from "../auth/passwords.js";
import {
  clearSession, COOKIE_NAME, isSecureRequest, issueSession, readCookie,
} from "../auth/sessions.js";
import {
  addEvent, countAdmins, createUser, deleteSessionsForUser, deleteUser, getUserById,
  getUserByName, listSessionsForUser, listUsers, markLogin, setUserPassword,
  setUserRole, type Role,
} from "../db/database.js";
import { checkLogin, recordFailure, recordSuccess } from "../auth/ratelimit.js";
import { clientIp, isLanRequest } from "../net/client.js";
import { logger } from "../logger.js";

const log = logger("auth");
export const auth = Router();

/**
 * Small delay on a failed login. The rate limiter is what actually stops
 * guessing; this just removes the timing difference between "no such user" and
 * "wrong password" for the handful of attempts allowed before the lockout.
 */
const FAIL_DELAY_MS = 400;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether this caller may create the first administrator.
 *
 * Whoever completes setup owns the app and every farm record in it, so it is
 * restricted to the local network. A token is the deliberate way to do it
 * remotely; it is compared only after the LAN check fails, and is useless once
 * an account exists.
 */
function mayRunSetup(req: import("express").Request): boolean {
  if (!config.setupLanOnly) return true;
  if (isLanRequest(req)) return true;

  const wanted = config.setupToken.trim();
  if (wanted === "") return false;

  const given = typeof req.query["setup_token"] === "string"
    ? req.query["setup_token"]
    : (req.headers["x-setup-token"] as string | undefined) ?? "";
  return given !== "" && timingSafeEqualStr(given, wanted);
}

/** Length-independent constant-time string compare. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Records an authentication event where the dashboard's event log can show it. */
function authEvent(
  severity: "info" | "warn" | "crit" | "good",
  kind: string,
  message: string,
  value?: string
) {
  addEvent({ ts: Date.now(), source: "auth", kind, severity, message, value: value ?? null });
}

/** Who am I, and does the dashboard need to show a setup or login screen? */
auth.get("/me", (req, res) => {
  const setupRequired = config.requireAuth && needsSetup();
  res.json({
    authRequired: config.requireAuth,
    setupRequired,
    // Lets the login page say "not from here" rather than offering a form that
    // will be refused — and, more to the point, rather than advertising to the
    // internet that this install is unclaimed.
    setupAllowed: setupRequired ? mayRunSetup(req) : false,
    onLan: isLanRequest(req),
    user: req.user ?? null,
  });
});

/**
 * Creates the first administrator. Only available while no account exists —
 * after that it is closed permanently, so it cannot be used to mint a second
 * admin later.
 */
auth.post("/setup", (req, res) => {
  if (!needsSetup()) {
    res.status(409).json({ error: "Setup has already been completed" });
    return;
  }

  // The gate that matters. Without it, publishing an install that has no
  // account yet hands the first passer-by an administrator account and the
  // farm records with it.
  if (!mayRunSetup(req)) {
    log.error(`refused first-run setup from ${clientIp(req)} — not on the LAN and no valid setup token`);
    authEvent("crit", "setup-refused", "Blocked an attempt to claim this app from outside the network");
    res.status(403).json({
      error:
        "The first administrator can only be created from the local network. " +
        "Open the app on the property, or set SETUP_TOKEN and supply it.",
    });
    return;
  }

  const { username, password } = req.body as { username?: unknown; password?: unknown };
  const uErr = validateUsername(username);
  if (uErr) { res.status(400).json({ error: uErr }); return; }
  const pErr = validatePassword(password as string);
  if (pErr) { res.status(400).json({ error: pErr }); return; }

  const name = (username as string).trim();
  const id = createUser(name, hashPassword(password as string), "admin");
  const user = getUserById(id)!;
  markLogin(id);
  issueSession(res, user, isSecureRequest(req), req.headers["user-agent"]?.slice(0, 80) ?? null);

  log.warn(`first administrator created: ${name}`);
  authEvent("warn", "setup", `First administrator account created: ${name}`);
  res.json({ ok: true, user: { id, username: name, role: "admin" } });
});

auth.post("/login", async (req, res) => {
  const { username, password } = req.body as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  const name = username.trim();
  const address = clientIp(req);

  // Checked before the password is hashed. A locked bucket costs nothing to
  // refuse, where verifying a password costs scrypt's memory-hard work — so
  // this sheds the load an attacker was trying to impose as well as the guess.
  const verdict = checkLogin(address, name);
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    res.status(429).json({
      error: "Too many failed sign-in attempts. Try again shortly.",
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
    return;
  }

  const user = getUserByName(name);
  // Same message and delay whether the account is missing or the password is
  // wrong — otherwise the response tells an attacker which usernames exist.
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(address, name);
    await wait(FAIL_DELAY_MS);
    log.warn(`failed login for "${name.slice(0, 32)}" from ${address}`);
    authEvent("warn", "login-failed", `Failed sign-in for "${name.slice(0, 32)}"`, address);
    res.status(401).json({ error: "Incorrect username or password" });
    return;
  }

  recordSuccess(address, name);
  markLogin(user.id);
  issueSession(res, user, isSecureRequest(req), req.headers["user-agent"]?.slice(0, 80) ?? null);

  const where = isLanRequest(req) ? "on the LAN" : "remotely";
  log.info(`signed in: ${user.username} (${user.role}) from ${address}`);
  authEvent("info", "login", `${user.username} signed in ${where}`, address);
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

auth.post("/logout", (req, res) => {
  clearSession(res, readCookie(req, COOKIE_NAME), isSecureRequest(req));
  res.json({ ok: true });
});

/** Any signed-in user may change their own password. */
auth.post("/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: unknown; newPassword?: unknown;
  };
  const me = req.user;
  if (!me) { res.status(401).json({ error: "Not signed in" }); return; }

  const row = getUserById(me.id);
  if (!row) { res.status(401).json({ error: "Account no longer exists" }); return; }

  if (typeof currentPassword !== "string" || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(403).json({ error: "Current password is incorrect" });
    return;
  }
  const pErr = validatePassword(newPassword as string);
  if (pErr) { res.status(400).json({ error: pErr }); return; }

  setUserPassword(me.id, hashPassword(newPassword as string));

  // Every other session for this account is ended. Someone changing their
  // password because they think it is known is not helped by leaving the
  // cookies made with the old one still working.
  const ended = deleteSessionsForUser(me.id, readCookie(req, COOKIE_NAME) ?? undefined);

  log.info(`${me.username} changed their password; ${ended} other session(s) ended`);
  authEvent("info", "password-changed", `${me.username} changed their password`);
  res.json({ ok: true, otherSessionsEnded: ended });
});

/* ------------------------------- sessions -------------------------------- */

/** The devices currently signed in as me, so a stray one can be spotted. */
auth.get("/sessions", requireAuth, (req, res) => {
  const me = req.user;
  if (!me) { res.status(401).json({ error: "Not signed in" }); return; }

  const current = readCookie(req, COOKIE_NAME);
  res.json(listSessionsForUser(me.id).map((s) => ({
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    label: s.label,
    current: s.token === current,
  })));
});

/** Signs this account out everywhere else — the lost-phone button. */
auth.post("/sessions/revoke-others", requireAuth, (req, res) => {
  const me = req.user;
  if (!me) { res.status(401).json({ error: "Not signed in" }); return; }

  const ended = deleteSessionsForUser(me.id, readCookie(req, COOKIE_NAME) ?? undefined);
  log.warn(`${me.username} ended ${ended} other session(s)`);
  authEvent("warn", "sessions-revoked", `${me.username} signed out ${ended} other device(s)`);
  res.json({ ok: true, ended });
});

/* ----------------------------- user management --------------------------- */

auth.get("/users", requireAuth, requireAdmin, (_req, res) => {
  res.json(listUsers().map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.created_at,
    lastLogin: u.last_login,
  })));
});

auth.post("/users", requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body as {
    username?: unknown; password?: unknown; role?: unknown;
  };

  const uErr = validateUsername(username);
  if (uErr) { res.status(400).json({ error: uErr }); return; }
  const pErr = validatePassword(password as string);
  if (pErr) { res.status(400).json({ error: pErr }); return; }
  if (role !== "admin" && role !== "viewer") {
    res.status(400).json({ error: "Role must be admin or viewer" });
    return;
  }

  const name = (username as string).trim();
  if (getUserByName(name)) {
    res.status(409).json({ error: `A user called "${name}" already exists` });
    return;
  }

  const id = createUser(name, hashPassword(password as string), role as Role);
  log.info(`${req.user?.username} created user ${name} (${role})`);
  authEvent("warn", "user-created", `${req.user?.username} created ${name} (${role})`);
  res.json({ ok: true, id, username: name, role });
});

auth.post("/users/:id/password", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params["id"]);
  const { password } = req.body as { password?: unknown };
  const target = getUserById(id);
  if (!target) { res.status(404).json({ error: "No such user" }); return; }

  const pErr = validatePassword(password as string);
  if (pErr) { res.status(400).json({ error: pErr }); return; }

  setUserPassword(id, hashPassword(password as string));
  // An admin resetting someone's password is usually a response to that
  // account being compromised, so their existing cookies go too.
  const ended = deleteSessionsForUser(id);

  log.warn(`${req.user?.username} reset the password for ${target.username}; ${ended} session(s) ended`);
  authEvent("warn", "password-reset",
    `${req.user?.username} reset the password for ${target.username}`);
  res.json({ ok: true, sessionsEnded: ended });
});

auth.post("/users/:id/role", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params["id"]);
  const { role } = req.body as { role?: unknown };
  const target = getUserById(id);
  if (!target) { res.status(404).json({ error: "No such user" }); return; }
  if (role !== "admin" && role !== "viewer") {
    res.status(400).json({ error: "Role must be admin or viewer" });
    return;
  }

  // Refuse to remove the last administrator, which would lock everyone out of
  // settings with no way back in short of editing the database by hand.
  if (target.role === "admin" && role === "viewer" && countAdmins() <= 1) {
    res.status(409).json({ error: "This is the only administrator; promote someone else first" });
    return;
  }

  setUserRole(id, role as Role);
  log.warn(`${req.user?.username} changed ${target.username} to ${role}`);
  authEvent("warn", "role-changed", `${req.user?.username} changed ${target.username} to ${role}`);
  res.json({ ok: true });
});

auth.delete("/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params["id"]);
  const target = getUserById(id);
  if (!target) { res.status(404).json({ error: "No such user" }); return; }

  if (req.user?.id === id) {
    res.status(409).json({ error: "You cannot delete the account you are signed in with" });
    return;
  }
  if (target.role === "admin" && countAdmins() <= 1) {
    res.status(409).json({ error: "This is the only administrator" });
    return;
  }

  // Sessions are declared ON DELETE CASCADE, but SQLite only enforces that
  // when foreign keys are switched on for the connection. Deleting them
  // explicitly means a deleted account cannot keep browsing on an old cookie
  // regardless of that pragma.
  deleteSessionsForUser(id);
  deleteUser(id);

  log.warn(`${req.user?.username} deleted user ${target.username}`);
  authEvent("warn", "user-deleted", `${req.user?.username} deleted ${target.username}`);
  res.json({ ok: true });
});
