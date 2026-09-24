import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt.
 *
 * scrypt is in Node's standard library, so this needs no dependency, and it is
 * deliberately memory-hard — a leaked hash is expensive to attack offline.
 * Parameters are stored alongside the hash so they can be raised later without
 * invalidating existing passwords.
 */

const KEYLEN = 64;
const COST = 16384; // 2^14
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, {
    N: COST, r: BLOCK_SIZE, p: PARALLELISM,
  });
  return [
    "scrypt", COST, BLOCK_SIZE, PARALLELISM,
    salt.toString("base64"), key.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }

  // Constant time, so a wrong password cannot be narrowed down by timing.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Rejects passwords that would make the whole exercise pointless. Deliberately
 * mild — this guards a farm dashboard on a private network, and a rule so
 * strict it drives people to reuse a password elsewhere is a net loss.
 */
export function validatePassword(password: string): string | null {
  if (typeof password !== "string") return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 200) return "Password is too long";
  if (/^\s|\s$/.test(password)) return "Password cannot start or end with a space";
  return null;
}

export function validateUsername(username: unknown): string | null {
  if (typeof username !== "string") return "Username is required";
  const u = username.trim();
  if (u.length < 2) return "Username must be at least 2 characters";
  if (u.length > 32) return "Username must be 32 characters or fewer";
  if (!/^[A-Za-z0-9._-]+$/.test(u)) {
    return "Username may contain only letters, numbers, dot, dash and underscore";
  }
  return null;
}
