import { randomUUID } from "node:crypto";
import { capacitySummary, CapacityError, commitLtcc, isLtccFile, parseLtcc, previewLtcc, setCondition, type LtccUpload } from "../pasture/capacity.js";
import { commitForage, forageSummary, ForageError, isForageFile, parseForage, previewForage, type ForageUpload } from "../pasture/forage.js";
import express, { Router } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db, setSetting } from "../db/database.js";
import { residual, type GateCandidate, type Outlook, type PlanGroup, type PlanProjection } from "../pasture/model.js";
import { checksStamp } from "../pasture/feedchecks.js";
import { FEED_HORIZON, makePlan, planGroups, planRules, setPlanRules } from "../pasture/plan.js";
import { allSegments, today } from "../stock/store.js";
import { parseWhen, setGate, StockError } from "../stock/actions.js";
import { Worker } from "node:worker_threads";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
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
  const key = `${k.k}|${residual()}|${checksStamp()}`;
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
  return runJob<Outlook | null>({ job: "outlook" });
}

/** Runs one of the model's slow jobs in a worker thread (see outlook-worker.ts). */
function runJob<T>(message: { job: "outlook" } | { job: "gates"; before: string } | { job: "plan"; groups: PlanGroup[]; residual: number; cap: number; floors?: Record<string, number> }): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../pasture/outlook-worker.js", import.meta.url));
    w.once("message", (m: { ok: boolean; result?: T; error?: string }) => {
      void w.terminate();
      if (m.ok) resolve(m.result as T); else reject(new Error(m.error));
    });
    w.once("error", reject);
    w.postMessage(message);
  });
}

/* ----------------------- gates probably left open ------------------------ */

/**
 * The day the app started keeping its own records. Before it, gate openings
 * were never recorded (AgriWebb's exports don't carry them), so that's the
 * stretch the finder searches; after it, what's recorded is what happened.
 */
function appStart(): string {
  const r = db.prepare("SELECT MIN(created_at) AS t FROM mob_events WHERE source = 'app'").get() as { t: number | null };
  return r.t ? new Date(r.t).toISOString().slice(0, 10) : today();
}

pastureApi.get("/pasture/gate-suggestions", requireAdmin, async (_req, res) => {
  const before = appStart();
  let found: GateCandidate[];
  try {
    found = await runJob<GateCandidate[]>({ job: "gates", before });
  } catch (e) {
    log.error("finding open gates failed", e);
    res.status(500).json({ error: "The gates couldn't be checked" });
    return;
  }
  const names = new Map((db.prepare("SELECT id, name FROM features").all() as Array<{ id: number; name: string }>).map((r) => [r.id, r.name]));
  const mobNames = new Map((db.prepare("SELECT id, name FROM mobs").all() as Array<{ id: number; name: string }>).map((r) => [r.id, r.name]));
  const segs = allSegments();
  res.json({
    before,
    suggestions: found.map((c) => ({
      ...c,
      stocked_name: names.get(c.stocked) ?? `#${c.stocked}`,
      other_name: names.get(c.other) ?? `#${c.other}`,
      // Who was in the stocked paddock over the stretch.
      mobs: [...new Set(segs.filter((s) => s.paddock_ids.includes(c.stocked) && s.from < c.to && (s.to === null || s.to > c.from))
        .map((s) => mobNames.get(s.mob_id) ?? `#${s.mob_id}`))],
    })),
  });
});

/**
 * Records the chosen suggestions: each gate opened the evening the stretch
 * began and closed at the start of the day it ended, marked as inferred.
 * All in one batch, so one Undo takes the lot back out.
 */
pastureApi.post("/pasture/inferred-gates", requireAdmin, (req, res) => {
  const items = Array.isArray((req.body ?? {})["items"]) ? (req.body["items"] as Array<Record<string, unknown>>) : [];
  if (!items.length) { res.status(400).json({ error: "Nothing chosen" }); return; }
  const who = req.user?.username ?? null;
  const batch = randomUUID();
  const done: number[] = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  items.forEach((it, index) => {
    const gate = Number(it["gate_id"]), home = Number(it["stocked"]);
    const from = String(it["from"] ?? ""), to = String(it["to"] ?? "");
    try {
      db.transaction(() => {
        setGate(gate, { state: "open", inferred: true }, parseWhen(from, "23:59"), who, false, batch);
        if (to <= today()) setGate(gate, { state: "closed", home, inferred: true }, parseWhen(to, "00:00"), who, false, batch);
      })();
      done.push(index);
    } catch (e) {
      skipped.push({ index, reason: e instanceof StockError ? e.message : "couldn't be recorded" });
    }
  });
  const msg = `${who} recorded ${done.length} gate opening${done.length === 1 ? "" : "s"} inferred from the pasture readings`;
  log.info(msg);
  addEvent({ ts: Date.now(), source: "pasture", kind: "action", severity: "info", message: msg, value: null });
  res.json({ ok: true, batch: done.length ? batch : null, recorded: done.length, skipped });
});

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
const pending = new Map<string, { report: CiboUpload | ForageUpload | LtccUpload; filename: string; at: number }>();
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
      if (isLtccFile(filename)) {
        const report = parseLtcc(filename, req.body);
        const id = randomUUID();
        pending.set(id, { report, filename, at: Date.now() });
        res.json({ importId: id, ...previewLtcc(report) });
        return;
      }
      if (isForageFile(filename)) {
        const report = parseForage(filename, req.body);
        const id = randomUUID();
        pending.set(id, { report, filename, at: Date.now() });
        res.json({ importId: id, ...previewForage(report) });
        return;
      }
      const report = parseCiboUpload(filename, req.body);
      for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
      const id = randomUUID();
      pending.set(id, { report, filename, at: Date.now() });
      res.json({ importId: id, ...(report.kind === "pasturekey" ? previewPastureKey(report.readings) : { kind: "farm-report", ...previewCibo(report) }) });
    } catch (e) {
      if (e instanceof PastureError || e instanceof ForageError || e instanceof CapacityError) { res.status(400).json({ error: e.message }); return; }
      log.error("reading a pasture report failed", e);
      res.status(500).json({ error: "That file couldn't be read" });
    }
  },
);

pastureApi.post("/pasture/import/:id/commit", requireAdmin, (req, res) => {
  forgetPlan(); // new readings: work the plan out again
  const p = pending.get(String(req.params["id"]));
  if (!p) { res.status(404).json({ error: "That preview has expired. Choose the file again." }); return; }
  pending.delete(String(req.params["id"]));
  if (p.report.kind === "ltcc") {
    commitLtcc(p.report);
    const msg = `${req.user?.username ?? null} imported FORAGE paddock carrying capacity from ${p.filename}`;
    log.info(msg);
    addEvent({ ts: Date.now(), source: "pasture", kind: "import", severity: "info", message: msg, value: null });
    res.json({ ok: true, forage: "ltcc" });
    return;
  }
  if (p.report.kind === "rainfall-pasture" || p.report.kind === "cover") {
    commitForage(p.report);
    const msg = `${req.user?.username ?? null} imported FORAGE ${p.report.kind === "cover" ? "ground cover" : "rainfall and pasture"} figures from ${p.filename}`;
    log.info(msg);
    addEvent({ ts: Date.now(), source: "pasture", kind: "import", severity: "info", message: msg, value: null });
    res.json({ ok: true, forage: p.report.kind });
    return;
  }
  const r = p.report.kind === "pasturekey" ? commitPastureKey(p.report.readings, p.filename) : commitCibo(p.report, p.filename);
  const who = req.user?.username ?? null;
  const what = p.report.kind === "pasturekey" ? "PastureKey paddock readings" : "a Cibo Labs pasture report";
  const msg = `${who} imported ${what} (${r.added} new, ${r.updated} updated) from ${p.filename}`;
  log.info(msg);
  addEvent({ ts: Date.now(), source: "pasture", kind: "import", severity: "info", message: msg, value: null });
  res.json({ ok: true, ...r });
});

/** FORAGE's long-term figures for the property, if any have been imported. */
pastureApi.get("/pasture/forage", (_req, res) => {
  res.json(forageSummary());
});

/** Long-term carrying capacity by paddock, against what each has carried. */
pastureApi.get("/pasture/capacity", (_req, res) => {
  res.json(capacitySummary());
});

/** Land condition for a paddock: the share in A, B, C and D. */
pastureApi.put("/pasture/capacity/:id/condition", requireAdmin, express.json(), (req, res) => {
  try {
    const c = setCondition(Number(req.params["id"]), (req.body ?? {}) as Record<string, unknown>);
    log.info(`${req.user?.username ?? null} set land condition for paddock ${req.params["id"]}: A ${c.a}% B ${c.b}% C ${c.c}% D ${c.d}%`);
    res.json(c);
  } catch (e) {
    if (e instanceof CapacityError) { res.status(400).json({ error: e.message }); return; }
    throw e;
  }
});

/* ------------------------------ rotation plan ----------------------------- */

/** For each mob: days left where it is, when to move, and the best paddocks to go to. */
/**
 * The projection takes several seconds, so it's worked out ahead and kept, on
 * disk as well so a restart doesn't lose it. It's worked out again when stock
 * moves or a mob changes (the groups), the residual changes, new pasture
 * readings come in, or it's a week old (for new weather). Anything that saves
 * (moves, imports, edits) starts that in the background straight away, so the
 * Rotation tab nearly always finds it ready. Days in a paddock, and the days
 * left where a mob is, are counted from today each time it's asked for.
 */
const PLAN_FILE = join(config.dataDir, "plan-cache.json");
const PLAN_MAX_AGE = 7 * 24 * 3600_000;
type PlanStore = { key: string; at: number; day: string; proj: PlanProjection | null };
let planCache: PlanStore | null = (() => {
  try { return JSON.parse(readFileSync(PLAN_FILE, "utf8")) as PlanStore; } catch { return null; }
})();
let planRun: { key: string; job: Promise<PlanStore> } | null = null;
let planStale = false; // new readings: work it out again whatever the key says

function planInputs() {
  const rules = planRules();
  const groups = planGroups();
  // Feed is projected past the longest stay, so a paddock with a margin beats one that only just lasts.
  const cap = Math.max(FEED_HORIZON, rules.max_days);
  const floors = paddockFloors();
  return { rules, groups, cap, floors, key: JSON.stringify({ groups, r: rules.residual, cap, floors, checks: checksStamp() }) };
}

/** Each paddock's own "leave at least" kg/ha, where one is set (poorer country). */
function paddockFloors(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of db.prepare("SELECT id, props FROM features WHERE kind = 'paddock' AND deleted_at IS NULL").all() as Array<{ id: number; props: string | null }>) {
    const v = Number((JSON.parse(f.props || "{}") as Record<string, unknown>)["residual_kg_ha"]);
    if (Number.isFinite(v) && v > 0) out[String(f.id)] = v;
  }
  return out;
}

let planFloors: Record<string, number> = {};
function workOutPlan(key: string, groups: PlanGroup[], residual: number, cap: number): Promise<PlanStore> {
  if (planRun?.key === key) return planRun.job;
  planStale = false;
  const job = runJob<PlanProjection | null>({ job: "plan", groups, residual, cap, floors: planFloors }).then((proj) => {
    const store = { key, at: Date.now(), day: today(), proj };
    if (planRun?.job === job) planRun = null;
    planCache = store;
    try { writeFileSync(PLAN_FILE, JSON.stringify(store)); } catch (e) { log.warn("couldn't save the plan cache", e); }
    return store;
  }, (e) => { if (planRun?.job === job) planRun = null; throw e; });
  planRun = { key, job };
  return job;
}

const planFresh = (key: string) => !!planCache && !planStale && planCache.key === key && Date.now() - planCache.at < PLAN_MAX_AGE;

/** Work the plan out again in the background if anything it depends on has changed. */
let planTimer: NodeJS.Timeout | null = null;
export function refreshPlanSoon(): void {
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    try {
      const { groups, rules, cap, key, floors } = planInputs(); planFloors = floors;
      if (!planFresh(key)) workOutPlan(key, groups, rules.residual, cap).catch((e) => log.error("rotation plan failed", e));
    } catch (e) { log.error("rotation plan failed", e); }
  }, 3000);
}
export function forgetPlan(): void { planStale = true; refreshPlanSoon(); }
// Ready after a restart, and fresh each week even if nothing is saved.
refreshPlanSoon();
setInterval(refreshPlanSoon, 6 * 3600_000).unref();

/** A projection from an earlier day: the feed where each mob is has had that many days' grazing since. */
function ageProjection(proj: PlanProjection, from: string): PlanProjection {
  const gone = Math.max(0, Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000));
  if (!gone) return proj;
  const current: PlanProjection["current"] = {};
  for (const [k, c] of Object.entries(proj.current)) {
    current[k] = { ...c, days: c.days && { low: Math.max(0, c.days.low - gone), median: Math.max(0, c.days.median - gone) } };
  }
  return { ...proj, current };
}

pastureApi.get("/plan", async (_req, res) => {
  try {
    const { rules, groups, cap, key, floors } = planInputs(); planFloors = floors;
    let store: PlanStore;
    if (planCache && !planStale && planCache.key === key) {
      // A week-old one is still served, and worked out again behind it.
      store = planCache;
      if (!planFresh(key)) workOutPlan(key, groups, rules.residual, cap).catch((e) => log.error("rotation plan failed", e));
    } else store = await workOutPlan(key, groups, rules.residual, cap);
    if (!store.proj) { res.json({ ok: false, reason: "No pasture readings yet: import Cibo's PastureKey readings first." }); return; }
    res.json({ ok: true, ...makePlan(ageProjection(store.proj, store.day), rules), worked_out: store.at });
  } catch (e) {
    log.error("rotation plan failed", e);
    res.status(500).json({ error: "The plan couldn't be worked out" });
  }
});

pastureApi.put("/plan/rules", requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, rules: setPlanRules((req.body ?? {}) as Record<string, unknown>) });
  } catch (e) {
    if (e instanceof StockError) { res.status(400).json({ error: e.message }); return; }
    res.status(500).json({ error: "Couldn't save the rules" });
  }
});
