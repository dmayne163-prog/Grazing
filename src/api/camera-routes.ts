/** Paddock cameras: list, add, change and remove them; their daily pictures. */
import { Router, type Request } from "express";
import { join } from "node:path";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db } from "../db/database.js";
import { logger } from "../logger.js";
import {
  addCamera, CAMERA_DIR, CameraError, camerasOn, getCamera, getShot, historyRun, listCameras, listShots, oldestRecording, removeCamera, startHistory, takeShot, updateCamera,
} from "../cameras/cameras.js";

const log = logger("cameras");
export const cameraApi = Router();
cameraApi.use(requireAuth);

const who = (req: Request) => req.user?.username ?? null;
const nameOf = (id: number) => (db.prepare("SELECT name FROM features WHERE id = ?").get(id) as { name: string | null } | undefined)?.name ?? `paddock #${id}`;
const logIt = (req: Request, msg: string) =>
  addEvent({ ts: Date.now(), source: "cameras", kind: "action", severity: "info", message: `${who(req)} ${msg}`, value: null });

function fail(res: import("express").Response, e: unknown, what: string) {
  if (e instanceof CameraError) { res.status(400).json({ error: e.message }); return; }
  log.error(`${what} failed`, e);
  res.status(500).json({ error: `Something went wrong ${what}` });
}

/** A paddock's cameras and pictures (newest first), and whether the NVR is set up. */
cameraApi.get("/cameras", (req, res) => {
  const id = Number(req.query["paddock"]);
  if (!Number.isInteger(id)) { res.json({ on: camerasOn(), cameras: listCameras() }); return; }
  const cameras = listCameras(id);
  res.json({ on: camerasOn(), cameras: cameras.map((c) => ({ ...c, history: historyRun(c.id) })), shots: listShots(id, 1000).map(({ file: _f, ...s }) => s) });
});

cameraApi.post("/cameras", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    const c = addCamera(Number(b["feature_id"]), b);
    logIt(req, `added camera ${c.name} (channel ${c.channel}) to ${nameOf(c.feature_id)}`);
    res.json({ ok: true, camera: c });
  } catch (e) { fail(res, e, "adding the camera"); }
});

cameraApi.patch("/cameras/:id", requireAdmin, (req, res) => {
  try {
    const c = updateCamera(Number(req.params["id"]), (req.body ?? {}) as Record<string, unknown>);
    logIt(req, `changed camera ${c.name} (channel ${c.channel})`);
    res.json({ ok: true, camera: c });
  } catch (e) { fail(res, e, "saving the camera"); }
});

cameraApi.delete("/cameras/:id", requireAdmin, (req, res) => {
  const c = getCamera(Number(req.params["id"]));
  if (!c || !removeCamera(c.id)) { res.status(404).json({ error: "No such camera" }); return; }
  logIt(req, `removed camera ${c.name} (channel ${c.channel}) from ${nameOf(c.feature_id)}`);
  res.json({ ok: true });
});

/** Take today's picture now (replacing one taken earlier today). */
cameraApi.post("/cameras/:id/shot", requireAdmin, async (req, res) => {
  const c = getCamera(Number(req.params["id"]));
  if (!c) { res.status(404).json({ error: "No such camera" }); return; }
  try {
    const s = await takeShot(c);
    const { file: _f, ...shot } = s;
    res.json({ ok: true, shot });
  } catch (e) { fail(res, e, "taking the picture"); }
});

/** How far back the NVR's recordings go for a camera. */
cameraApi.get("/cameras/:id/recordings", requireAdmin, async (req, res) => {
  const c = getCamera(Number(req.params["id"]));
  if (!c) { res.status(404).json({ error: "No such camera" }); return; }
  try { res.json({ oldest: await oldestRecording(c.channel), run: historyRun(c.id) }); }
  catch (e) { fail(res, e, "searching the recordings"); }
});

/** Fill in past days from the NVR's recordings, from a date to yesterday (in the background). */
cameraApi.post("/cameras/:id/history", requireAdmin, (req, res) => {
  const c = getCamera(Number(req.params["id"]));
  if (!c) { res.status(404).json({ error: "No such camera" }); return; }
  try {
    const run = startHistory(c, String((req.body as Record<string, unknown>)?.["from"] ?? ""));
    logIt(req, `started filling in ${c.name} from the NVR's recordings since ${run.from}`);
    res.json({ ok: true, run });
  } catch (e) { fail(res, e, "starting the fill-in"); }
});

cameraApi.get("/cameras/:id/history", (req, res) => {
  res.json({ run: historyRun(Number(req.params["id"])) });
});

/** One picture. Pictures never change once taken (a retake gets a new id), so they can be kept. */
cameraApi.get("/camera-shots/:id.jpg", (req, res) => {
  const s = getShot(Number(req.params["id"]));
  if (!s) { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(join(CAMERA_DIR, s.file), (e) => { if (e && !res.headersSent) res.status(404).end(); });
});
