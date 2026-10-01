import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db, setSetting } from "../db/database.js";
import { residual, type Outlook } from "../pasture/model.js";
import { Worker } from "node:worker_threads";
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

/*
 * The outlook takes a couple of seconds to work out, so it's kept until
 * something it depends on changes: a reading, a stock record, the weather, the
 * paddocks or the residual.
 */
let outlookCache: { key: string; value: Promise<Outlook | null> } | null = null;
function outlook(): Promise<Outlook | null> {
  const k = db.prepare(`
    SELECT (SELECT MAX(updated_at) FROM pasture_obs) || '|' ||
           (SELECT COUNT(*) || ':' || IFNULL(MAX(id), 0) FROM mob_events) || '|' ||
           (SELECT IFNULL(MIN(last_date), '') FROM climate_cells) || '|' ||
           (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), 0) || ':' || IFNULL(MAX(deleted_at), 0) FROM features WHERE kind = 'paddock') || '|' ||
           (SELECT IFNULL(MAX(created_at), 0) FROM mobs) AS k
  `).get() as { k: string };
  const key = `${k.k}|${residual()}`;
  if (outlookCache?.key !== key) {
    const t0 = Date.now();
    const value = inWorker().then((o) => {
      log.info(`pasture outlook worked out in ${Date.now() - t0} ms`);
      return o;
    });
    // A failure isn't kept: the next request tries again.
    value.catch((e) => { log.error("pasture outlook failed", e); if (outlookCache?.value === value) outlookCache = null; });
    outlookCache = { key, value };
  }
  return outlookCache.value;
}

// Worked out ahead of time — a minute after start-up, then hourly, which only
// does anything when something has changed — so it's usually ready when the
// tab is opened rather than taking ten seconds or more on the server.
setTimeout(() => { outlook().catch(() => { /* logged */ }); }, 60_000).unref();
setInterval(() => { outlook().catch(() => { /* logged */ }); }, 3_600_000).unref();

function inWorker(): Promise<Outlook | null> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../pasture/outlook-worker.js", import.meta.url));
    w.once("message", (m: { ok: boolean; outlook?: Outlook | null; error?: string }) => {
      void w.terminate();
      if (m.ok) resolve(m.outlook ?? null); else reject(new Error(m.error));
    });
    w.once("error", reject);
    w.postMessage("go");
  });
}

/** The outlook for every paddock and the property, without the day-by-day bands. */
pastureApi.get("/pasture/outlook", async (_req, res) => {
  let o: Outlook | null;
  try { o = await outlook(); } catch { res.status(500).json({ error: "The pasture outlook couldn't be worked out" }); return; }
  if (!o) { res.json(null); return; }
  res.json({
    ...o,
    fit: o.fit ? { ...o.fit, multipliers: undefined } : null,
    paddocks: o.paddocks.map((p) => ({ ...p, series: undefined })),
  });
});

/** One paddock's outlook, with its dry-to-wet bands, for its chart. */
pastureApi.get("/pasture/outlook/:id", async (req, res) => {
  let o: Outlook | null;
  try { o = await outlook(); } catch { res.status(500).json({ error: "The pasture outlook couldn't be worked out" }); return; }
  const p = o?.paddocks.find((x) => x.id === Number(req.params["id"]));
  res.json(p ? { ...p, as_of: o!.as_of, residual: o!.residual, horizon: o!.horizon, years: o!.years } : null);
});

/** The cover to graze down to: what "days of grazing left" counts to. */
pastureApi.put("/pasture/residual", requireAdmin, (req, res) => {
  const v = Number((req.body ?? {})["kg_ha"]);
  if (!Number.isFinite(v) || v < 200 || v > 4000) { res.status(400).json({ error: "Give the residual in kg/ha, between 200 and 4,000" }); return; }
  setSetting("pasture_residual", String(Math.round(v)));
  addEvent({ ts: Date.now(), source: "pasture", kind: "action", severity: "info", message: `${req.user?.username ?? null} set the pasture residual to ${Math.round(v)} kg/ha`, value: null });
  res.json({ ok: true });
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
