/**
 * Login throttling.
 *
 * The previous defence was a fixed 400 ms delay on a failed password. That
 * slows a single guesser and does nothing at all to fifty parallel
 * connections, which is exactly what a login page on the public internet
 * attracts. This tracks failures and refuses to answer once there have been
 * too many, so guessing costs wall-clock time no matter how much concurrency
 * is thrown at it.
 *
 * Two buckets are counted independently:
 *
 *  - **by address**, which stops one host working through a password list; and
 *  - **by username**, which stops a botnet spreading the same guesses for one
 *    account across thousands of addresses, where no single address ever looks
 *    busy enough to notice.
 *
 * Held in memory on purpose. It is one process, the state is worthless after a
 * restart, and writing every failed guess to SQLite would hand an attacker a
 * cheap way to hammer the disk.
 */
import { logger } from "../logger.js";

const log = logger("ratelimit");

/** Failures older than this stop counting. */
const WINDOW_MS = 15 * 60_000;

/** Failures allowed inside the window before the bucket locks. */
const MAX_FAILURES = 5;

/** First lockout; each consecutive lockout doubles it, up to the cap. */
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 30 * 60_000;

/** A username bucket is more tolerant — several people share one account. */
const MAX_FAILURES_USER = 10;

interface Bucket {
  /** Timestamps of recent failures, oldest first. */
  failures: number[];
  /** When the bucket unlocks; 0 when it is not locked. */
  lockedUntil: number;
  /** How many times this bucket has locked, for the escalating backoff. */
  lockCount: number;
  /** Last touched, so idle buckets can be swept. */
  seen: number;
}

const byAddress = new Map<string, Bucket>();
const byUsername = new Map<string, Bucket>();

/** Cap the maps so a flood of distinct addresses cannot exhaust memory. */
const MAX_BUCKETS = 10_000;

function bucket(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) {
    if (map.size >= MAX_BUCKETS) sweep(map, true);
    b = { failures: [], lockedUntil: 0, lockCount: 0, seen: Date.now() };
    map.set(key, b);
  }
  b.seen = Date.now();
  return b;
}

function prune(b: Bucket, now: number) {
  const cutoff = now - WINDOW_MS;
  while (b.failures.length > 0 && (b.failures[0] as number) < cutoff) b.failures.shift();
}

export interface Verdict {
  allowed: boolean;
  /** How long the caller must wait, in whole seconds. */
  retryAfterSeconds: number;
}

const ALLOWED: Verdict = { allowed: true, retryAfterSeconds: 0 };

function verdictFor(b: Bucket, now: number): Verdict {
  if (b.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((b.lockedUntil - now) / 1000) };
  }
  return ALLOWED;
}

/**
 * Asked before a password is checked. A locked bucket is refused without ever
 * touching the hash, so a lockout also sheds the scrypt work — which is the
 * expensive part, and otherwise a denial-of-service in its own right.
 */
export function checkLogin(address: string, username: string): Verdict {
  const now = Date.now();

  const a = bucket(byAddress, address);
  prune(a, now);
  const av = verdictFor(a, now);
  if (!av.allowed) return av;

  const u = bucket(byUsername, username.toLowerCase());
  prune(u, now);
  return verdictFor(u, now);
}

export function recordFailure(address: string, username: string) {
  const now = Date.now();

  const a = bucket(byAddress, address);
  prune(a, now);
  a.failures.push(now);
  if (a.failures.length >= MAX_FAILURES) lock(a, now, `address ${address}`);

  const u = bucket(byUsername, username.toLowerCase());
  prune(u, now);
  u.failures.push(now);
  if (u.failures.length >= MAX_FAILURES_USER) lock(u, now, `account "${username}"`);
}

function lock(b: Bucket, now: number, what: string) {
  b.lockCount += 1;
  const ms = Math.min(BASE_LOCKOUT_MS * 2 ** (b.lockCount - 1), MAX_LOCKOUT_MS);
  b.lockedUntil = now + ms;
  b.failures = [];
  log.warn(`locked out ${what} for ${Math.round(ms / 1000)}s after repeated failed logins`);
}

/**
 * A correct password clears that address and account. The lock *count* is kept
 * so someone who guesses their way in after five lockouts does not get a fresh
 * allowance every time they succeed once.
 */
export function recordSuccess(address: string, username: string) {
  const a = byAddress.get(address);
  if (a) { a.failures = []; a.lockedUntil = 0; }
  const u = byUsername.get(username.toLowerCase());
  if (u) { u.failures = []; u.lockedUntil = 0; }
}

/** Current failure count for an address, for the event log. */
export function failureCount(address: string): number {
  const b = byAddress.get(address);
  if (!b) return 0;
  prune(b, Date.now());
  return b.failures.length;
}

function sweep(map: Map<string, Bucket>, aggressive = false) {
  const now = Date.now();
  const idleFor = aggressive ? WINDOW_MS : 2 * WINDOW_MS;
  for (const [key, b] of map) {
    if (b.lockedUntil > now) continue;
    if (now - b.seen > idleFor) map.delete(key);
  }
}

/** Swept on a timer so long-idle buckets do not accumulate. */
export function startRateLimitSweeper(): NodeJS.Timeout {
  const t = setInterval(() => {
    sweep(byAddress);
    sweep(byUsername);
  }, WINDOW_MS);
  t.unref();
  return t;
}

export const rateLimitPolicy = {
  windowMinutes: WINDOW_MS / 60_000,
  maxFailures: MAX_FAILURES,
  maxFailuresPerAccount: MAX_FAILURES_USER,
};
