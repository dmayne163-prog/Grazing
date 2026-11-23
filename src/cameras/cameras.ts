/**
 * Paddock cameras: one picture a day from each security camera that looks
 * over a paddock, taken from the NVR's live video with ffmpeg (this Dahua NVR
 * refuses its snapshot command to anything but an admin login, while live
 * view is allowed). Pictures are kept as JPEGs in DATA_DIR/cameras, about
 * 1920 px wide, and shown on the paddock's page.
 */
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { db } from "../db/database.js";
import { logger } from "../logger.js";
import { today } from "../stock/store.js";
import { findClips, gotoPreset } from "./nvr-http.js";
import { asRoi, cleanRoi, measure, type Roi } from "./greenness.js";

const log = logger("cameras");
export const CAMERA_DIR = join(config.dataDir, "cameras");

/** preset: for a turning (PTZ) camera, the saved position it's turned to for this paddock. */
export interface Camera { id: number; channel: number; preset: number | null; name: string; feature_id: number; created_at: number; roi: Roi | null }
export interface Shot {
  id: number; camera_id: number; feature_id: number; taken_on: string; taken_at: number; file: string; bytes: number;
  /** Greenness in the camera's grass box (null: no box, or not read yet); gcc_ok 0 with gcc_why: a picture that can't be trusted. */
  gcc: number | null; gcc_ok: number | null; gcc_why: string | null; gcc_roi: string | null;
  from_recording: number | null;
}
type CameraRow = Omit<Camera, "roi"> & { roi: string | null };
const fromRow = (r: CameraRow): Camera => {
  let roi: Roi | null = null;
  try { roi = r.roi ? asRoi(JSON.parse(r.roi)) : null; } catch { roi = null; }
  return { ...r, roi };
};

export class CameraError extends Error {}

export const camerasOn = () => !!(config.nvrHost && config.nvrUser);

export function listCameras(featureId?: number): Camera[] {
  return ((featureId === undefined
    ? db.prepare("SELECT id, channel, preset, name, feature_id, created_at, roi FROM cameras WHERE deleted_at IS NULL ORDER BY channel, preset, id").all()
    : db.prepare("SELECT id, channel, preset, name, feature_id, created_at, roi FROM cameras WHERE deleted_at IS NULL AND feature_id = ? ORDER BY channel, preset, id").all(featureId)) as CameraRow[]).map(fromRow);
}

export function getCamera(id: number): Camera | null {
  const r = db.prepare("SELECT id, channel, preset, name, feature_id, created_at, roi FROM cameras WHERE id = ? AND deleted_at IS NULL").get(id) as CameraRow | undefined;
  return r ? fromRow(r) : null;
}

function clean(b: Record<string, unknown>, old?: Camera) {
  const channel = b["channel"] === undefined && old ? old.channel : Number(b["channel"]);
  if (!Number.isInteger(channel) || channel < 1 || channel > 256) throw new CameraError("Channel: the camera's number on the NVR, e.g. 4");
  const name = b["name"] === undefined && old ? old.name : (typeof b["name"] === "string" ? b["name"].trim().slice(0, 80) : "");
  if (!name) throw new CameraError("Give the camera a name, e.g. Almum trough");
  const pv = b["preset"] === undefined && old ? old.preset : b["preset"];
  const preset = pv === null || pv === undefined || pv === "" ? null : Number(pv);
  if (preset !== null && (!Number.isInteger(preset) || preset < 1 || preset > 255)) throw new CameraError("Preset: the saved position's number on the NVR, e.g. 1, or blank for a fixed camera");
  let roi: Roi | null;
  try { roi = b["roi"] === undefined && old ? old.roi : cleanRoi(b["roi"]); } catch (e) { throw new CameraError((e as Error).message); }
  return { channel, name, preset, roi };
}

export function addCamera(featureId: number, b: Record<string, unknown>): Camera {
  const f = db.prepare("SELECT kind FROM features WHERE id = ? AND deleted_at IS NULL").get(featureId) as { kind: string } | undefined;
  if (f?.kind !== "paddock") throw new CameraError("A camera goes on a paddock");
  const c = clean(b);
  const r = db.prepare("INSERT INTO cameras (channel, preset, name, feature_id, created_at, roi) VALUES (?, ?, ?, ?, ?, ?)").run(c.channel, c.preset, c.name, featureId, Date.now(), c.roi ? JSON.stringify(c.roi) : null);
  return getCamera(Number(r.lastInsertRowid))!;
}

export function updateCamera(id: number, b: Record<string, unknown>): Camera {
  const old = getCamera(id);
  if (!old) throw new CameraError("That camera doesn't exist any more");
  const c = clean(b, old);
  db.prepare("UPDATE cameras SET channel = ?, preset = ?, name = ?, roi = ? WHERE id = ?").run(c.channel, c.preset, c.name, c.roi ? JSON.stringify(c.roi) : null, id);
  // A new grass box: read every picture again in the background.
  if (JSON.stringify(c.roi) !== JSON.stringify(old.roi)) void scoreMissing().catch((e) => log.error("greenness failed", e));
  return getCamera(id)!;
}

/** Stops the daily pictures; the pictures already taken stay. */
export function removeCamera(id: number): boolean {
  return db.prepare("UPDATE cameras SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), id).changes > 0;
}

/** A paddock's pictures, newest first, with each one's camera name. */
export function listShots(featureId: number, limit = 400): Array<Shot & { camera: string }> {
  return db.prepare(`SELECT s.*, c.name AS camera FROM camera_shots s JOIN cameras c ON c.id = s.camera_id
    WHERE s.feature_id = ? ORDER BY s.taken_on DESC, c.channel, s.id DESC LIMIT ?`).all(featureId, limit) as Array<Shot & { camera: string }>;
}

export function getShot(id: number): Shot | null {
  return (db.prepare("SELECT * FROM camera_shots WHERE id = ?").get(id) as Shot | undefined) ?? null;
}

/** The RTSP address of a channel's main stream, login included (never logged). */
function streamUrl(channel: number): string {
  const auth = `${encodeURIComponent(config.nvrUser)}:${encodeURIComponent(config.nvrPass)}`;
  return `rtsp://${auth}@${config.nvrHost}:${config.nvrRtspPort}/cam/realmonitor?channel=${channel}&subtype=0`;
}

/** A recording's RTSP address from a local time on ("YYYY-MM-DD HH:MM:SS"), for 20 seconds. */
function playbackUrl(channel: number, from: string): string {
  const auth = `${encodeURIComponent(config.nvrUser)}:${encodeURIComponent(config.nvrPass)}`;
  const t0 = Date.parse(from.replace(" ", "T"));
  const fmt = (ms: number) => { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}_${p(d.getHours())}_${p(d.getMinutes())}_${p(d.getSeconds())}`; };
  return `rtsp://${auth}@${config.nvrHost}:${config.nvrRtspPort}/cam/playback?channel=${channel}&starttime=${fmt(t0)}&endtime=${fmt(t0 + 20_000)}`;
}

/** One frame of a channel's live video (or of a recording, from a local time) into a JPEG file, at most 1920 px wide. */
function grabFrame(channel: number, out: string, recordedAt?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", recordedAt ? playbackUrl(channel, recordedAt) : streamUrl(channel),
      // Live: skip the first second, the picture settles once a full frame has arrived.
      ...(recordedAt ? [] : ["-ss", "1"]), "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", "-q:v", "3", "-y", out,
    ];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.on("error", (e) => { clearTimeout(timer); reject(new CameraError(`ffmpeg couldn't start: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      // Never pass on ffmpeg's own words unfiltered: they can include the stream address.
      const why = err.replace(/rtsp:\/\/[^\s]+/g, "rtsp://…").trim().split("\n").pop() ?? "";
      if (code === 0) resolve(); else reject(new CameraError(`No picture from channel ${channel}${why ? `: ${why}` : ""}`));
    });
  });
}

/*
 * A turning camera is turned to the paddock's preset and given time to settle
 * before its picture, then turned back to its usual view: the lowest preset
 * used on that channel (set that one to where it normally looks). Only one
 * picture is taken at a time, so two turns never overlap.
 */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The preset a turning camera's channel goes back to: the lowest used for it. */
function homePreset(channel: number): number | null {
  const r = db.prepare("SELECT MIN(preset) AS p FROM cameras WHERE channel = ? AND preset IS NOT NULL AND deleted_at IS NULL").get(channel) as { p: number | null };
  return r.p;
}

/** Today's picture from one camera (turned to its preset first, and back after), replacing any taken earlier today. */
export function takeShot(cam: Camera): Promise<Shot> {
  return oneAtATime(async () => {
    if (cam.preset === null) return grabShot(cam);
    await turnTo(cam.channel, cam.preset);
    try { return await grabShot(cam); }
    finally { await turnHome(cam.channel); }
  });
}

async function turnTo(channel: number, preset: number) {
  await gotoPreset(channel, preset);
  await sleep(config.cameraPtzSettle * 1000);
}
async function turnHome(channel: number) {
  const home = homePreset(channel);
  if (home === null) return;
  try { await gotoPreset(channel, home); } catch (e) { log.warn(`couldn't turn channel ${channel} back to preset ${home}: ${e instanceof Error ? e.message : String(e)}`); }
}

async function grabShot(cam: Camera): Promise<Shot> {
  if (!camerasOn()) throw new CameraError("No camera NVR is set up on the server (NVR_HOST, NVR_USER, NVR_PASS)");
  const day = today();
  const dir = join(CAMERA_DIR, String(cam.id));
  mkdirSync(dir, { recursive: true });
  const file = `${cam.id}/${day}.jpg`;
  const path = join(CAMERA_DIR, file);
  const tmp = `${path}.part.jpg`;
  try {
    await grabFrame(cam.channel, tmp);
    const bytes = statSync(tmp).size;
    if (bytes < 2000) throw new CameraError(`Channel ${cam.channel} gave an empty picture`);
    renameSync(tmp, path);
    db.prepare("DELETE FROM camera_shots WHERE camera_id = ? AND taken_on = ?").run(cam.id, day);
    const r = db.prepare("INSERT INTO camera_shots (camera_id, feature_id, taken_on, taken_at, file, bytes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(cam.id, cam.feature_id, day, Date.now(), file, bytes);
    const shot = getShot(Number(r.lastInsertRowid))!;
    if (cam.roi) await scoreShot(shot, cam.roi).catch((e) => log.warn(`greenness for ${cam.name}: ${String(e)}`));
    return getShot(shot.id)!;
  } finally {
    try { unlinkSync(tmp); } catch { /* moved or never made */ }
  }
}

/** Every camera without a picture today, one at a time (the NVR serves one stream at a time happily). */
export async function takeDailyShots(): Promise<{ taken: number; failed: number }> {
  const day = today();
  let taken = 0, failed = 0;
  const due = listCameras().filter((cam) => !db.prepare("SELECT 1 FROM camera_shots WHERE camera_id = ? AND taken_on = ?").get(cam.id, day));
  const note = (cam: Camera, e: unknown) => { failed++; log.warn(`camera ${cam.name} (channel ${cam.channel}${cam.preset !== null ? `, preset ${cam.preset}` : ""}): ${e instanceof Error ? e.message : String(e)}`); };
  for (const cam of due.filter((c) => c.preset === null)) {
    try { await takeShot(cam); taken++; } catch (e) { note(cam, e); }
  }
  // Turning cameras: every preset of a channel in one round, back to its usual view once at the end.
  for (const channel of new Set(due.filter((c) => c.preset !== null).map((c) => c.channel))) {
    await oneAtATime(async () => {
      try {
        for (const cam of due.filter((c) => c.channel === channel && c.preset !== null)) {
          try { await turnTo(channel, cam.preset!); await grabShot(cam); taken++; } catch (e) { note(cam, e); }
        }
      } finally { await turnHome(channel); }
    });
  }
  if (taken || failed) log.info(`camera pictures: ${taken} taken, ${failed} failed`);
  return { taken, failed };
}

/** From CAMERA_HOUR each day, checked every 20 minutes, so a missed picture is tried again later that day. */
export function startCameraShots(): NodeJS.Timeout | null {
  if (!camerasOn()) return null;
  let busy = false;
  const tick = () => {
    if (busy || new Date().getHours() < config.cameraHour || new Date().getHours() >= 17) return;
    busy = true;
    takeDailyShots().catch((e) => log.error("camera pictures failed", e)).finally(() => { busy = false; });
  };
  const t = setInterval(tick, 20 * 60_000);
  t.unref();
  setTimeout(tick, 90_000).unref();
  setTimeout(() => { scoreMissing().catch((e) => log.error("greenness failed", e)); }, 30_000).unref();
  return t;
}

/* ------------------------------- greenness -------------------------------- */

async function scoreShot(shot: Shot, roi: Roi): Promise<void> {
  const g = await measure(join(CAMERA_DIR, shot.file), roi);
  db.prepare("UPDATE camera_shots SET gcc = ?, gcc_ok = ?, gcc_why = ?, gcc_roi = ? WHERE id = ?")
    .run(g.gcc, g.ok ? 1 : 0, g.why, JSON.stringify(roi), shot.id);
}

let scoring: Promise<number> | null = null;
/** Scores every picture not yet read with its camera's current grass box (after a box is set or moved, and at start-up). */
export function scoreMissing(): Promise<number> {
  if (scoring) return scoring.then(() => scoreMissing());
  scoring = (async () => {
    let n = 0;
    for (const cam of listCameras()) {
      if (!cam.roi) continue;
      const key = JSON.stringify(cam.roi);
      const shots = db.prepare("SELECT * FROM camera_shots WHERE camera_id = ? AND (gcc_roi IS NULL OR gcc_roi != ?)").all(cam.id, key) as Shot[];
      for (const s of shots) {
        try { await scoreShot(s, cam.roi); n++; } catch (e) { log.warn(`greenness for ${cam.name} ${s.taken_on}: ${String(e)}`); }
      }
    }
    if (n) log.info(`greenness read for ${n} camera picture(s)`);
    return n;
  })().finally(() => { scoring = null; });
  return scoring;
}

/* ------------------------- past days from recordings ------------------------ */

/*
 * The NVR keeps months of motion-triggered clips. For each past day without a
 * picture, up to three clips are taken across the morning (nearest 9:30,
 * 10:30 and 11:30) and the one with the middle greenness kept, so cattle
 * walking through one of them (what set the recording off) don't skew the
 * day. Without a grass area the clip nearest 10:30 is kept. Fixed cameras
 * only: a turning camera's past pointing isn't known.
 */
export interface HistoryRun { camera_id: number; name: string; from: string; to: string; day: string | null; done: number; added: number; total: number; finished: boolean; error: string | null }
const runs = new Map<number, HistoryRun>();
export const historyRun = (cameraId: number) => runs.get(cameraId) ?? null;

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TARGETS = ["09:30:00", "10:30:00", "11:30:00"];

export function startHistory(cam: Camera, from: string): HistoryRun {
  if (!camerasOn()) throw new CameraError("No camera NVR is set up on the server");
  if (cam.preset !== null) throw new CameraError("A turning camera's past days can't be filled in: where it pointed then isn't known");
  if (runs.get(cam.id) && !runs.get(cam.id)!.finished) return runs.get(cam.id)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new CameraError("From: a date");
  const days: string[] = [];
  const end = new Date(`${today()}T00:00:00`);
  for (let d = new Date(`${from}T00:00:00`); d < end; d.setDate(d.getDate() + 1)) days.push(isoDay(d));
  const run: HistoryRun = { camera_id: cam.id, name: cam.name, from, to: days[days.length - 1] ?? from, day: null, done: 0, added: 0, total: days.length, finished: false, error: null };
  runs.set(cam.id, run);
  void (async () => {
    try {
      for (const day of [...days].reverse()) { // newest first: the useful end fills in first
        run.day = day;
        const has = db.prepare("SELECT 1 FROM camera_shots WHERE camera_id = ? AND taken_on = ?").get(cam.id, day);
        if (!has && await historyDay(cam, day)) run.added++;
        run.done++;
      }
    } catch (e) {
      run.error = e instanceof Error ? e.message : String(e);
      log.warn(`filling in ${cam.name}: ${run.error}`);
    } finally {
      run.finished = true; run.day = null;
      log.info(`filled in ${run.added} past day(s) for ${cam.name} from the NVR's recordings`);
    }
  })();
  return run;
}

async function historyDay(cam: Camera, day: string): Promise<boolean> {
  const clips = await findClips(cam.channel, `${day} 08:30:00`, `${day} 12:30:00`);
  if (!clips.length) return false;
  const secs = (t: string) => Date.parse(t.replace(" ", "T")) / 1000;
  // The clip nearest each target time, two seconds in (past the motion that started it).
  const picks = [...new Set(TARGETS.map((t) => {
    const want = secs(`${day} ${t}`);
    return clips.reduce((best, c) => (Math.abs(secs(c.start) - want) < Math.abs(secs(best.start) - want) ? c : best)).start;
  }))];
  const dir = join(CAMERA_DIR, String(cam.id));
  mkdirSync(dir, { recursive: true });
  const tries: Array<{ tmp: string; at: string; gcc: number | null; ok: boolean; why: string | null }> = [];
  for (const start of picks) {
    const at = new Date((secs(start) + 2) * 1000);
    const atStr = `${isoDay(at)} ${at.toTimeString().slice(0, 8)}`;
    const tmp = join(dir, `${day}.try${tries.length}.jpg`);
    try {
      await grabFrame(cam.channel, tmp, atStr);
      if (statSync(tmp).size < 2000) { unlinkSync(tmp); continue; }
      const g = cam.roi ? await measure(tmp, cam.roi).catch(() => null) : null;
      tries.push({ tmp, at: atStr, gcc: g?.gcc ?? null, ok: !!g?.ok, why: g?.why ?? null });
      if (!cam.roi) break; // nothing to compare: the first good one does
    } catch { try { unlinkSync(tmp); } catch { /* none */ } }
  }
  if (!tries.length) return false;
  // The middle score of the trusted ones; else the first.
  const good = tries.filter((t) => t.ok && t.gcc !== null).sort((a, b) => a.gcc! - b.gcc!);
  const keep = good.length ? good[Math.floor((good.length - 1) / 2)]! : tries[0]!;
  const file = `${cam.id}/${day}.jpg`;
  renameSync(keep.tmp, join(CAMERA_DIR, file));
  for (const t of tries) if (t !== keep) try { unlinkSync(t.tmp); } catch { /* gone */ }
  db.prepare(`INSERT INTO camera_shots (camera_id, feature_id, taken_on, taken_at, file, bytes, gcc, gcc_ok, gcc_why, gcc_roi, from_recording)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(cam.id, cam.feature_id, day, Date.parse(keep.at.replace(" ", "T")), file, statSync(join(CAMERA_DIR, file)).size,
    keep.gcc, cam.roi ? (keep.ok ? 1 : 0) : null, keep.why, cam.roi ? JSON.stringify(cam.roi) : null);
  return true;
}

/** The oldest day the NVR still has recordings for on a channel (searched month by month from a year back). */
export async function oldestRecording(channel: number): Promise<string | null> {
  const now = new Date();
  for (let back = 12; back >= 0; back--) {
    const a = new Date(now.getFullYear(), now.getMonth() - back, 1), b = new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
    const clips = await findClips(channel, `${isoDay(a)} 00:00:00`, `${isoDay(b)} 00:00:00`);
    if (clips.length) return clips[0]!.start.slice(0, 10);
  }
  return null;
}
