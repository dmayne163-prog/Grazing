import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent } from "../db/database.js";
import { logger } from "../logger.js";
import {
  ciboBoundary, commitCibo, coverage, farmReadings, parseCiboUpload, PastureError, previewCibo, type CiboReport,
} from "../pasture/cibo.js";

const log = logger("pasture");
export const pastureApi = Router();
pastureApi.use(requireAuth);

pastureApi.get("/pasture", (_req, res) => {
  const boundary = ciboBoundary();
  res.json({ farm: farmReadings(), coverage: boundary ? coverage(boundary) : null });
});

/* A parsed report waits here between preview and commit; it is small. */
const pending = new Map<string, { report: CiboReport; filename: string; at: number }>();
const PENDING_MS = 30 * 60_000;

pastureApi.post(
  "/pasture/import/preview",
  requireAdmin,
  express.raw({ type: () => true, limit: "40mb" }),
  (req, res) => {
    const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "")).slice(0, 200);
    if (!filename || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "No file received" });
      return;
    }
    try {
      const report = parseCiboUpload(filename, req.body);
      for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
      const id = randomUUID();
      pending.set(id, { report, filename, at: Date.now() });
      res.json({ importId: id, ...previewCibo(report) });
    } catch (e) {
      if (e instanceof PastureError) { res.status(400).json({ error: e.message }); return; }
      log.error("reading a pasture report failed", e);
      res.status(500).json({ error: "That file couldn't be read" });
    }
  },
);

pastureApi.post("/pasture/import/:id/commit", requireAdmin, (req, res) => {
  const p = pending.get(String(req.params["id"]));
  if (!p) { res.status(404).json({ error: "That preview has expired. Choose the file again." }); return; }
  pending.delete(String(req.params["id"]));
  const r = commitCibo(p.report, p.filename);
  const who = req.user?.username ?? null;
  const msg = `${who} imported a Cibo Labs pasture report (${r.added} new months, ${r.updated} updated) from ${p.filename}`;
  log.info(msg);
  addEvent({ ts: Date.now(), source: "pasture", kind: "import", severity: "info", message: msg, value: null });
  res.json({ ok: true, ...r });
});
