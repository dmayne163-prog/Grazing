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

const log = logger("cameras");
export const CAMERA_DIR = join(config.dataDir, "cameras");

export interface Camera { id: number; channel: number; name: string; feature_id: number; created_at: number }
export interface Shot { id: number; camera_id: number; feature_id: number; taken_on: string; taken_at: number; file: string; bytes: number }

export class CameraError extends Error {}

export const camerasOn = () => !!(config.nvrHost && config.nvrUser);

export function listCameras(featureId?: number): Camera[] {
  return (featureId === undefined
    ? db.prepare("SELECT id, channel, name, feature_id, created_at FROM cameras WHERE deleted_at IS NULL ORDER BY channel").all()
    : db.prepare("SELECT id, channel, name, feature_id, created_at FROM cameras WHERE deleted_at IS NULL AND feature_id = ? ORDER BY channel").all(featureId)) as Camera[];
}

export function getCamera(id: number): Camera | null {
  return (db.prepare("SELECT id, channel, name, feature_id, created_at FROM cameras WHERE id = ? AND deleted_at IS NULL").get(id) as Camera | undefined) ?? null;
}

function clean(b: Record<string, unknown>, old?: Camera) {
  const channel = b["channel"] === undefined && old ? old.channel : Number(b["channel"]);
  if (!Number.isInteger(channel) || channel < 1 || channel > 256) throw new CameraError("Channel: the camera's number on the NVR, e.g. 4");
  const name = b["name"] === undefined && old ? old.name : (typeof b["name"] === "string" ? b["name"].trim().slice(0, 80) : "");
  if (!name) throw new CameraError("Give the camera a name, e.g. Almum trough");
  return { channel, name };
}

export function addCamera(featureId: number, b: Record<string, unknown>): Camera {
  const f = db.prepare("SELECT kind FROM features WHERE id = ? AND deleted_at IS NULL").get(featureId) as { kind: string } | undefined;
  if (f?.kind !== "paddock") throw new CameraError("A camera goes on a paddock");
  const c = clean(b);
  const r = db.prepare("INSERT INTO cameras (channel, name, feature_id, created_at) VALUES (?, ?, ?, ?)").run(c.channel, c.name, featureId, Date.now());
  return getCamera(Number(r.lastInsertRowid))!;
}

export function updateCamera(id: number, b: Record<string, unknown>): Camera {
  const old = getCamera(id);
  if (!old) throw new CameraError("That camera doesn't exist any more");
  const c = clean(b, old);
  db.prepare("UPDATE cameras SET channel = ?, name = ? WHERE id = ?").run(c.channel, c.name, id);
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

/** One frame of a channel's live video into a JPEG file, at most 1920 px wide. */
function grabFrame(channel: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", streamUrl(channel),
      // Skip the first second: the picture settles once a full frame has arrived.
      "-ss", "1", "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", "-q:v", "3", "-y", out,
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

/** Takes today's picture from one camera, replacing any taken earlier today. */
export async function takeShot(cam: Camera): Promise<Shot> {
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
    return getShot(Number(r.lastInsertRowid))!;
  } finally {
    try { unlinkSync(tmp); } catch { /* moved or never made */ }
  }
}

/** Every camera without a picture today, one at a time (the NVR serves one stream at a time happily). */
export async function takeDailyShots(): Promise<{ taken: number; failed: number }> {
  const day = today();
  let taken = 0, failed = 0;
  for (const cam of listCameras()) {
    const has = db.prepare("SELECT 1 FROM camera_shots WHERE camera_id = ? AND taken_on = ?").get(cam.id, day);
    if (has) continue;
    try { await takeShot(cam); taken++; }
    catch (e) { failed++; log.warn(`camera ${cam.name} (channel ${cam.channel}): ${e instanceof Error ? e.message : String(e)}`); }
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
  return t;
}
