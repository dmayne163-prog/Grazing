import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

mkdirSync(config.dataDir, { recursive: true });
const file = join(config.dataDir, "grazing.db");

export const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at    INTEGER NOT NULL,
  last_login    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  label      TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Sign-ins, account changes and anything else worth being able to look back on.
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  source   TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  severity TEXT    NOT NULL,
  message  TEXT    NOT NULL,
  value    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

-- The farm map. One row per paddock, fence, water point and so on, holding its
-- current state. Geometry is GeoJSON in WGS84 (lon/lat), the same as every
-- source it is imported from and every map library that draws it.
--
-- Rows are never deleted, only marked. Grazing history will refer to paddocks
-- by id, and a paddock that was merged or removed years ago still has to
-- resolve when its old mob movements are read back.
CREATE TABLE IF NOT EXISTS features (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  subtype    TEXT,
  props      TEXT    NOT NULL DEFAULT '{}',
  geometry   TEXT    NOT NULL,
  -- Derived from the geometry on every save, so lists and stocking rates never
  -- have to recompute them. Area for polygons, length for lines.
  area_ha    REAL,
  length_m   REAL,
  rev        INTEGER NOT NULL DEFAULT 1,
  -- Where it came from: "drawn", "import:<id>", "split:<parent id>".
  source     TEXT    NOT NULL,
  parent_id  INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_features_kind ON features(kind) WHERE deleted_at IS NULL;

-- Every version of every feature, appended on each change. This is what lets a
-- paddock's area be known *as it was* on a given date once it has been
-- subdivided — a stocking rate from 2023 has to use the 2023 fence line — and
-- it is also the undo history for a bad edit.
CREATE TABLE IF NOT EXISTS feature_revisions (
  feature_id INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  username   TEXT,
  action     TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  subtype    TEXT,
  props      TEXT    NOT NULL,
  geometry   TEXT    NOT NULL,
  area_ha    REAL,
  length_m   REAL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (feature_id, rev),
  FOREIGN KEY (feature_id) REFERENCES features(id)
);

-- An uploaded map file, parsed and held for review before anything is written
-- to the map. The parsed shapes live here so "import" can act on exactly what
-- was previewed rather than re-parsing a file the browser may no longer have.
CREATE TABLE IF NOT EXISTS imports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  username     TEXT,
  filename     TEXT    NOT NULL,
  format       TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('preview','committed','discarded')),
  payload      TEXT    NOT NULL,
  committed_at INTEGER,
  created_ids  TEXT
);

-- A mob: a group of animals managed together. What it *is* lives here; where
-- it is, how many and how heavy are not stored on the row but worked out from
-- its events, so the state on any past date can be reconstructed — which
-- stocking-rate history and pasture projections both depend on.
CREATE TABLE IF NOT EXISTS mobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  species      TEXT    NOT NULL DEFAULT 'Cattle',
  breed        TEXT,
  age_class    TEXT,
  -- 'female', 'male', 'steer', or null where the class does not say
  -- (weaners, yearlings) and nobody has recorded it.
  sex          TEXT,
  tag_colour   TEXT,
  management_tag TEXT,
  origin       TEXT,
  birth_date   TEXT,
  description  TEXT,
  -- Null for the property's own stock; the owner's name for agistment cattle,
  -- which graze here but are not part of the herd's numbers or value.
  owner        TEXT,
  data         TEXT    NOT NULL DEFAULT '{}',
  source       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER
);

-- Everything that happens to a mob, dated. Current state is these folded up
-- in date order:
--   opening  sets head and location, the starting point of an imported mob
--   move     sets location (one or more paddocks, gates open between them)
--   weigh    records an average weight and optionally an assumed daily gain
--   count    corrects head without a sale or death
--   purchase / sale / death / transfer  change head by head_change
CREATE TABLE IF NOT EXISTS mob_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mob_id      INTEGER NOT NULL,
  date        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  head        INTEGER,
  head_change INTEGER,
  weight_kg   REAL,
  adg_kg      REAL,
  paddock_ids TEXT,
  data        TEXT    NOT NULL DEFAULT '{}',
  source      TEXT    NOT NULL,
  username    TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (mob_id) REFERENCES mobs(id)
);
CREATE INDEX IF NOT EXISTS idx_mob_events_mob ON mob_events(mob_id, date);

-- Rain gauges, optionally tied to a point on the map.
CREATE TABLE IF NOT EXISTS rain_gauges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  feature_id INTEGER,
  notes      TEXT,
  created_at INTEGER NOT NULL
);

-- One reading from one gauge. The date is the day the rain is booked to and
-- time is when the gauge was read, where known. Readings are kept exactly as
-- entered; the 9am rain-day convention SILO and the BOM use is applied when
-- comparing, not by rewriting what was recorded.
CREATE TABLE IF NOT EXISTS rain_readings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  gauge_id   INTEGER NOT NULL,
  date       TEXT    NOT NULL,
  time       TEXT,
  mm         REAL    NOT NULL,
  note       TEXT,
  source     TEXT    NOT NULL,
  username   TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (gauge_id) REFERENCES rain_gauges(id)
);
CREATE INDEX IF NOT EXISTS idx_rain_date ON rain_readings(date);

-- Small key/value settings changed from the app rather than the environment.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* --------------------------------- events -------------------------------- */

export interface EventRow {
  id: number;
  ts: number;
  source: string;
  kind: string;
  severity: "info" | "warn" | "crit" | "good";
  message: string;
  value: string | null;
}

export function addEvent(e: Omit<EventRow, "id">) {
  db.prepare(
    "INSERT INTO events (ts, source, kind, severity, message, value) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(e.ts, e.source, e.kind, e.severity, e.message, e.value);
}

export function getEvents(limit: number): EventRow[] {
  return db.prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ?").all(limit) as EventRow[];
}

/* -------------------------------- settings ------------------------------- */

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/* --------------------------------- users --------------------------------- */

export type Role = "admin" | "viewer";

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: number;
  last_login: number | null;
}

export function countUsers(): number {
  return (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
}

export function getUserByName(username: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined) ?? null;
}

export function getUserById(id: number): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
}

export function listUsers(): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY role, username").all() as UserRow[];
}

export function createUser(username: string, passwordHash: string, role: Role): number {
  const r = db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)"
  ).run(username, passwordHash, role, Date.now());
  return Number(r.lastInsertRowid);
}

export function setUserPassword(id: number, passwordHash: string) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function setUserRole(id: number, role: Role) {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
}

export function markLogin(id: number) {
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(Date.now(), id);
}

export function deleteUser(id: number) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function countAdmins(): number {
  return (db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get() as { n: number }).n;
}

/* -------------------------------- sessions ------------------------------- */

export interface SessionRow {
  token: string;
  user_id: number;
  created_at: number;
  expires_at: number;
  label: string | null;
}

export function createSession(token: string, userId: number, expiresAt: number, label: string | null) {
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at, label) VALUES (?, ?, ?, ?, ?)"
  ).run(token, userId, Date.now(), expiresAt, label);
}

export function getSession(token: string): SessionRow | null {
  return (db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as SessionRow | undefined) ?? null;
}

export function deleteSession(token: string) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function deleteExpiredSessions(): number {
  return db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()).changes;
}

export function touchSession(token: string, expiresAt: number) {
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(expiresAt, token);
}

export function listSessionsForUser(userId: number): SessionRow[] {
  return db.prepare(
    "SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC"
  ).all(userId) as SessionRow[];
}

/**
 * Ends every session for a user, optionally sparing the one making the
 * request — the lever to pull when a phone is lost or a password is suspected.
 */
export function deleteSessionsForUser(userId: number, exceptToken?: string): number {
  if (exceptToken) {
    return db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?")
      .run(userId, exceptToken).changes;
  }
  return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes;
}

export function checkpointWal() {
  db.pragma("wal_checkpoint(PASSIVE)");
}
