import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db } from "../db/database.js";
import { logger } from "../logger.js";
import {
  ciboBoundary, commitCibo, commitPastureKey, coverage, farmReadings, paddockLatest, paddockSeries, parseCiboUpload,
  PastureError, previewCibo, previewPastureKey, type CiboUpload,
} from "../pasture/cibo.js";

const log = logger("pasture");
export const pastureApi = Router();
pastureApi.use(requireAuth);

/*
 * Overlaying every paddock on Cibo's boundary takes a moment, and the tab asks
 * on every redraw, so the answer is kept until a paddock or the boundary changes.
 */
let coverageCache: { key: string; value: ReturnType<typeof coverage> | null } | null = null;
function cachedCoverage() {
  const boundary = ciboBoundary();
  const stamp = db.prepare(
    "SELECT COUNT(*) AS n, MAX(updated_at) AS t, MAX(deleted_at) AS d FROM features WHERE kind = 'paddock'"
  ).get() as { n: number; t: number | null; d: number | null };
  const key = `${stamp.n}|${stamp.t}|${stamp.d}|${boundary ? JSON.stringify(boundary).length : 0}`;
  if (coverageCache?.key !== key) coverageCache = { key, value: boundary ? coverage(boundary) : null };
  return coverageCache.value;
}

pastureApi.get("/pasture", (_req, res) => {
  res.json({ farm: farmReadings(), coverage: cachedCoverage(), paddocks: paddockLatest() });
});

/** The newest PastureKey reading per paddock: the paddock list and the map use it. */
pastureApi.get("/pasture/latest", (_req, res) => {
  res.json(paddockLatest());
});

/** Every PastureKey reading for one paddock, oldest first. */
pastureApi.get("/pasture/paddocks/:id", (req, res) => {
  res.json(paddockSeries(Number(req.params["id"])));
});

/* A parsed report waits here between preview and commit; it is small. */
const pending = new Map<string, { report: CiboUpload; filename: string; at: number }>();
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
      res.json({ importId: id, ...(report.kind === "pasturekey" ? previewPastureKey(report.readings) : { kind: "farm-report", ...previewCibo(report) }) });
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
  const r = p.report.kind === "pasturekey" ? commitPastureKey(p.report.readings, p.filename) : commitCibo(p.report, p.filename);
  const who = req.user?.username ?? null;
  const what = p.report.kind === "pasturekey" ? "PastureKey paddock readings" : "a Cibo Labs pasture report";
  const msg = `${who} imported ${what} (${r.added} new, ${r.updated} updated) from ${p.filename}`;
  log.info(msg);
  addEvent({ ts: Date.now(), source: "pasture", kind: "import", severity: "info", message: msg, value: null });
  res.json({ ok: true, ...r });
});
