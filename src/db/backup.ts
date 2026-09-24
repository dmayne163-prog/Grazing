/**
 * Nightly copies of the database.
 *
 * Once AgriWebb is cancelled this database is the only record of the farm's
 * mobs, movements and rainfall, so it copies itself every night into
 * DATA_DIR/backups — inside the volume Unraid's appdata backup already covers,
 * which puts each night's copy in two places without any extra setup.
 *
 * SQLite's online backup is used rather than copying the file: the database
 * is in WAL mode, and a plain file copy taken mid-write can be torn.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "./database.js";

const log = logger("backup");

export const backupDir = join(config.dataDir, "backups");
const PREFIX = "grazing-";
const KEEP = Math.max(1, config.backupKeep);

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function listBackups(): Array<{ file: string; bytes: number; at: number }> {
  try {
    return readdirSync(backupDir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith(".db"))
      .map((file) => {
        const st = statSync(join(backupDir, file));
        return { file, bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.file.localeCompare(a.file));
  } catch {
    return [];
  }
}

/** Writes today's backup (replacing one already made today) and prunes old ones. */
export async function backupNow(): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const file = join(backupDir, `${PREFIX}${stamp()}.db`);
  await db.backup(file);
  for (const old of listBackups().slice(KEEP)) {
    try { unlinkSync(join(backupDir, old.file)); } catch { /* next night */ }
  }
  log.info(`backed up to ${file}`);
  return file;
}

/** A fresh copy to a given path, for the download button. */
export async function backupTo(path: string): Promise<void> {
  await db.backup(path);
}

/**
 * Runs once a day at BACKUP_HOUR local time, and straight away at start-up if
 * today has no backup yet — so a server that is rebooted every evening still
 * gets one.
 */
export function startBackups(): NodeJS.Timeout {
  const today = `${PREFIX}${stamp()}.db`;
  if (!listBackups().some((b) => b.file === today)) {
    backupNow().catch((e) => log.error(`start-up backup failed: ${String(e)}`));
  }
  let lastDay = stamp();
  const t = setInterval(() => {
    const now = new Date();
    if (now.getHours() !== config.backupHour || stamp(now) === lastDay) return;
    lastDay = stamp(now);
    backupNow().catch((e) => log.error(`nightly backup failed: ${String(e)}`));
  }, 10 * 60_000);
  t.unref();
  return t;
}
