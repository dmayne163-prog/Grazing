import express, { Router, type Request } from "express";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { addEvent, db } from "../db/database.js";
import { logger } from "../logger.js";
import { ImportError } from "../map/importers.js";
import { listFeatures, updateFeature, type FeatureRow } from "../map/store.js";

const listFeaturesOfKind = (kind: string) => listFeatures().filter((f) => f.kind === kind);
import {
  asOfFromFilename, parseAgriWebbSheet, reviewMobs,
  type MobCandidate, type MovementRow, type PaddockRowCandidate, type RainRow,
} from "../stock/agriwebb-xlsx.js";
import { addReading, ensureGauge, gaugeByName, readingExists } from "../rain/store.js";
import {
  deleteAppEvent, draftMob, moveMobs, parseWhen, setGate, StockError, undoBatch,
  type DraftInput, type GateInput,
} from "../stock/actions.js";
import { gateHistory, gateInfo, gateStateAt, isGate, listGates } from "../map/gates.js";
import { getFeature } from "../map/store.js";
import {
  commitHistory, historyAlreadyImported, planHistory, replayMovements,
} from "../stock/agriwebb-history.js";
import {
  createMobWithEvents, EVENT_ORDER, mobViews, paddockHistories, paddockStock, recordsBegin,
  today, updateMob, type EventInput,
} from "../stock/store.js";

const log = logger("stock");
export const stockApi = Router();
stockApi.use(requireAuth);

const who = (req: Request) => req.user?.username ?? null;

/* ------------------------------- paddocks -------------------------------- */

interface PaddockInfo {
  row: FeatureRow;
  props: Record<string, unknown>;
  /** The area stocking rates are worked on: grazable if set, else mapped. */
  area: number | null;
}

function paddockIndex() {
  const byId = new Map<number, PaddockInfo>();
  const byName = new Map<string, PaddockInfo>();
  for (const row of listFeatures()) {
    if (row.kind !== "paddock") continue;
    const props = JSON.parse(row.props) as Record<string, unknown>;
    const g = Number(props["grazable_ha"]);
    const info = { row, props, area: Number.isFinite(g) && g > 0 ? g : row.area_ha };
    byId.set(row.id, info);
    byName.set(normName(row.name), info);
  }
  return { byId, byName };
}

/** Names are matched ignoring case and spacing — "No.2 Upper" and "no.2  upper" are one paddock. */
const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/* --------------------------------- views --------------------------------- */

stockApi.get("/mobs", (req, res) => {
  const asOf = typeof req.query["date"] === "string" ? req.query["date"] : today();
  const { byId } = paddockIndex();
  res.json(mobViews(asOf).map((v) => ({
    id: v.mob.id,
    name: v.mob.name,
    species: v.mob.species,
    breed: v.mob.breed,
    age_class: v.mob.age_class,
    sex: v.mob.sex,
    tag_colour: v.mob.tag_colour,
    origin: v.mob.origin,
    birth_date: v.mob.birth_date,
    description: v.mob.description,
    owner: v.mob.owner,
    ...v.state,
    paddocks: v.state.paddock_ids.map((id) => ({ id, name: byId.get(id)?.row.name ?? `#${id}` })),
    ae_head: v.ae_head,
    ae_total: v.ae_total,
    agriwebb_ae_head: v.agriwebb_ae_head,
  })));
});

stockApi.patch("/mobs/:id", requireAdmin, (req, res) => {
  const id = Number(req.params["id"]);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const edit: Record<string, unknown> = {};
  for (const k of ["name", "owner", "sex", "description"]) if (k in b) edit[k] = b[k];
  const before = Number.isInteger(id) ? mobViews().find((v) => v.mob.id === id)?.mob : undefined;
  const row = before ? updateMob(id, edit) : null;
  if (!row) { res.status(404).json({ error: "No such mob" }); return; }
  if (before && before.owner !== row.owner) {
    const what = row.owner ? `agistment, owner ${row.owner}` : "own stock";
    addEvent({
      ts: Date.now(), source: "stock", kind: "mob-owner", severity: "info",
      message: `${who(req)} marked ${row.name} as ${what}`, value: null,
    });
    log.info(`${who(req)} marked ${row.name} as ${what}`);
  }
  res.json({ ok: true });
});

/* -------------------------------- actions -------------------------------- */

/** Runs an action, mapping its errors onto a 400 with the message. */
function act(res: import("express").Response, fn: () => unknown) {
  try {
    res.json({ ok: true, ...(fn() as object) });
  } catch (e) {
    if (e instanceof StockError) { res.status(400).json({ error: e.message }); return; }
    log.error("action failed", e);
    res.status(500).json({ error: "Something went wrong recording that" });
  }
}

function logAction(req: Request, message: string) {
  log.info(`${who(req)} ${message}`);
  addEvent({ ts: Date.now(), source: "stock", kind: "action", severity: "info", message: `${who(req)} ${message}`, value: null });
}

const nameOf = (id: number) => getFeature(id)?.name ?? `#${id}`;
const noteOf = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);

/** Moves one mob, or several together, to a paddock or a set with gates open between. */
stockApi.post("/actions/move", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(res, () => {
    const ids = Array.isArray(b["mob_ids"]) ? (b["mob_ids"] as unknown[]).map(Number) : [];
    const when = parseWhen(b["date"], b["time"]);
    const batch = moveMobs(ids, b["to"], when, noteOf(b["note"]), who(req));
    const to = Array.isArray(b["to"]) ? (b["to"] as unknown[]).map(Number).map(nameOf).join(", ") : "";
    logAction(req, `moved ${ids.length} mob(s) to ${to} (${when.date} ${when.time ?? ""})`);
    return { batch };
  });
});

/** The older one-mob move, kept so nothing that calls it breaks. */
stockApi.post("/mobs/:id/move", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(res, () => ({
    batch: moveMobs([Number(req.params["id"])], b["paddock_ids"], parseWhen(b["date"], b["time"]), noteOf(b["note"]), who(req)),
  }));
});

stockApi.post("/mobs/:id/draft", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(res, () => {
    const r = draftMob(Number(req.params["id"]), b as unknown as DraftInput, parseWhen(b["date"], b["time"]), who(req));
    logAction(req, `drafted ${String(b["head"])} hd off mob #${req.params["id"]} into mob #${r.mob_id}`);
    return r;
  });
});

stockApi.post("/undo/:batch", requireAdmin, (req, res) => {
  act(res, () => {
    const r = undoBatch(String(req.params["batch"]));
    logAction(req, `undid an action (${r.events} record(s), ${r.mobs} mob(s), ${r.gates} gate change(s))`);
    return r;
  });
});

stockApi.delete("/mob-events/:id", requireAdmin, (req, res) => {
  act(res, () => {
    deleteAppEvent(Number(req.params["id"]));
    logAction(req, `deleted mob record #${req.params["id"]}`);
    return {};
  });
});

/* --------------------------------- gates --------------------------------- */

stockApi.get("/gates", (_req, res) => {
  res.json(listGates());
});

stockApi.get("/gates/:id", (req, res) => {
  const id = Number(req.params["id"]);
  const g = getFeature(id);
  if (!g || !isGate(g)) { res.status(404).json({ error: "No such gate" }); return; }
  const info = gateInfo(g, listFeaturesOfKind("paddock"), gateStateAt(id, "9999-12-31", null));
  res.json({
    ...info,
    paddock_names: info.paddocks.map(nameOf),
    history: gateHistory(id).map((e) => ({ ...e, paddocks: [nameOf(e.paddock_a), nameOf(e.paddock_b)] })),
  });
});

/** What opening or closing would do, without doing it. */
stockApi.post("/gates/:id/preview", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(res, () => {
    const r = setGate(Number(req.params["id"]), b as unknown as GateInput, parseWhen(b["date"], b["time"]), who(req), true);
    return { ...r, changes: r.changes.map((c) => ({ ...c, from_names: c.from.map(nameOf), to_names: c.to.map(nameOf) })) };
  });
});

stockApi.post("/gates/:id", requireAdmin, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  act(res, () => {
    const when = parseWhen(b["date"], b["time"]);
    const r = setGate(Number(req.params["id"]), b as unknown as GateInput, when, who(req));
    const verb = b["state"] === "open" ? "opened" : "closed";
    logAction(req, `${verb} ${nameOf(Number(req.params["id"]))} between ${r.paddocks.map(nameOf).join(" and ")} (${when.date} ${when.time ?? ""}); ${r.changes.length} mob(s) affected`);
    return r;
  });
});

/** Sets by hand which two paddocks a gate joins; null goes back to working it out. */
stockApi.put("/gates/:id/paddocks", requireAdmin, (req, res) => {
  const id = Number(req.params["id"]);
  const g = getFeature(id);
  if (!g || !isGate(g) || g.deleted_at !== null) { res.status(404).json({ error: "No such gate" }); return; }
  const raw = (req.body as { paddocks?: unknown })?.paddocks;
  const props = JSON.parse(g.props) as Record<string, unknown>;
  if (raw === null) {
    delete props["connects"];
  } else {
    const ids = Array.isArray(raw) ? [...new Set(raw.map(Number))] : [];
    if (ids.length !== 2 || !ids.every((p) => getFeature(p)?.kind === "paddock")) {
      res.status(400).json({ error: "Choose two different paddocks" });
      return;
    }
    props["connects"] = ids;
  }
  try {
    updateFeature(id, { kind: g.kind, name: g.name, subtype: g.subtype, props, geometry: JSON.parse(g.geometry) }, g.rev, who(req));
    res.json({ ok: true });
  } catch (e) {
    log.error("setting gate paddocks failed", e);
    res.status(500).json({ error: "Something went wrong" });
  }
});

/** Everything that has happened to one mob, newest first. */
stockApi.get("/mobs/:id/events", (req, res) => {
  const id = Number(req.params["id"]);
  const { byId } = paddockIndex();
  const mobName = new Map((db.prepare("SELECT id, name FROM mobs").all() as Array<{ id: number; name: string }>).map((m) => [m.id, m.name]));
  const rows = db.prepare(
    `SELECT * FROM mob_events WHERE mob_id = ? ORDER BY ${EVENT_ORDER}`
  ).all(id) as Array<{ id: number; date: string; time: string | null; batch: string | null; kind: string; head: number | null; head_change: number | null; weight_kg: number | null; paddock_ids: string | null; data: string; source: string }>;
  rows.reverse(); // newest first
  res.json(rows.map((e) => {
    const data = JSON.parse(e.data) as Record<string, unknown>;
    return {
      id: e.id, time: e.time, batch: e.batch,
      reason: data["reason"] ?? null, gate_name: data["gate_name"] ?? null,
      date: e.date, kind: e.kind, head: e.head, head_change: e.head_change, weight_kg: e.weight_kg,
      paddocks: e.paddock_ids ? (JSON.parse(e.paddock_ids) as number[]).map((p) => byId.get(p)?.row.name ?? `#${p}`) : null,
      agriwebb_event: data["agriwebb_event"] ?? null,
      to_mob: typeof data["to_mob"] === "number" ? mobName.get(data["to_mob"]) ?? null : null,
      from_mob: typeof data["from_mob"] === "number" ? mobName.get(data["from_mob"]) ?? null : null,
      to_paddock: data["to_paddock"] ?? null,
      off_farm: data["off_farm"] === true,
      note: data["note"] ?? null,
      source: e.source,
    };
  }));
});

/** Rest and use for every paddock: the summary behind the paddock list. */
stockApi.get("/grazing", (_req, res) => {
  const out = [...paddockHistories().values()].map(({ periods, rests, ...summary }) => summary);
  res.json({ records_begin: recordsBegin(), paddocks: out });
});

stockApi.get("/paddocks/:id/grazing", (req, res) => {
  const id = Number(req.params["id"]);
  const h = paddockHistories().get(id);
  const { byId } = paddockIndex();
  const name = (pid: number) => byId.get(pid)?.row.name ?? `#${pid}`;
  res.json({
    records_begin: recordsBegin(),
    history: h ? {
      ...h,
      periods: h.periods.map((p) => ({ ...p, shared_with: p.shared_with.map(name) })),
    } : null,
  });
});

stockApi.get("/stock", (req, res) => {
  const asOf = typeof req.query["date"] === "string" ? req.query["date"] : today();
  const { byId } = paddockIndex();
  res.json(paddockStock((id) => byId.get(id)?.area ?? null, asOf));
});

/* --------------------------------- import -------------------------------- */

interface ImportRow { id: number; filename: string; format: string; status: string; payload: string }

/** A mob already brought in from an earlier export, recognised by what does not change. */
const mobKey = (m: { source_name: string; birth_date: string | null; breed: string | null; tag_colour: string | null; head?: number }) =>
  [m.source_name, m.birth_date, m.breed, m.tag_colour].map((x) => String(x ?? "").toLowerCase()).join("|");

stockApi.post(
  "/import/records/preview",
  requireAdmin,
  express.raw({ type: () => true, limit: "20mb" }),
  async (req, res) => {
    const filename = decodeURIComponent(String(req.headers["x-filename"] ?? "")).slice(0, 200);
    if (!filename || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "No file received" });
      return;
    }
    try {
      const parsed = await parseAgriWebbSheet(req.body);
      const asOf = asOfFromFilename(filename, today());
      const { byId, byName } = paddockIndex();

      if (parsed.type === "mobs") {
        for (const m of parsed.mobs) {
          for (const n of m.paddock_names) {
            const p = byName.get(normName(n));
            if (p) m.paddock_ids.push(p.row.id);
            else m.unmatched_paddocks.push(n);
          }
          if (m.unmatched_paddocks.length) {
            m.warnings.unshift(`Not on the map: ${m.unmatched_paddocks.join(", ")}. Import the map first, or fix the name.`);
          }
        }
        reviewMobs(parsed.mobs, asOf);

        const existing = new Map<string, number>();
        for (const v of mobViews()) {
          const data = JSON.parse(v.mob.data) as Record<string, unknown>;
          if (typeof data["agriwebb_key"] === "string") existing.set(data["agriwebb_key"], v.mob.id);
        }
        const matches: Record<number, number> = {};
        for (const m of parsed.mobs) {
          const hit = existing.get(mobKey(m));
          if (hit !== undefined) matches[m.i] = hit;
        }

        const id = storePreview(req, filename, "agriwebb-mobs", { asOf, mobs: parsed.mobs });
        res.json({ importId: id, type: "mobs", asOf, mobs: parsed.mobs, matches });
        return;
      }

      if (parsed.type === "rainfall") {
        const gauges = [...new Set(parsed.readings.map((x) => x.gauge))].map((name) => {
          const rows = parsed.readings.filter((x) => x.gauge === name);
          const existing = gaugeByName(name);
          const dups = existing ? rows.filter((x) => readingExists(existing.id, x.date, x.time, x.mm)).length : 0;
          return { name, readings: rows.length, mm: rows.reduce((t, x) => t + x.mm, 0), existing: !!existing, duplicates: dups };
        });
        const dates = parsed.readings.map((x) => x.date).sort();
        const id = storePreview(req, filename, "agriwebb-rainfall", { readings: parsed.readings });
        res.json({
          importId: id, type: "rainfall", readings: parsed.readings.length,
          first: dates[0] ?? null, last: dates[dates.length - 1] ?? null, gauges,
          // Newest first, as AgriWebb lists them.
          rows: [...parsed.readings].sort((a, b) => (a.date < b.date ? 1 : -1)),
        });
        return;
      }

      if (parsed.type === "movements") {
        const replay = replayMovements(parsed.movements);
        const lookup = (n: string) => byName.get(normName(n))?.row.id ?? null;
        const plan = planHistory(replay, lookup);
        const already = historyAlreadyImported();
        const counts: Record<string, number> = {};
        for (const r of parsed.movements) counts[r.event] = (counts[r.event] ?? 0) + 1;
        const ended: Record<string, number> = {};
        for (const l of replay.lineages) if (l.closed) ended[l.closed.why] = (ended[l.closed.why] ?? 0) + 1;
        const id = storePreview(req, filename, "agriwebb-movements", { movements: parsed.movements });
        res.json({
          importId: id, type: "movements",
          records: parsed.movements.length, counts,
          first: replay.first, last: replay.last,
          mobs: replay.lineages.length, live: plan.matched.length, ended,
          plan: { ...plan, matched: plan.matched.map((m) => m.mob_name) },
          notes: replay.notes,
          alreadyImported: already,
          canImport: plan.ok && !already,
        });
        return;
      }

      // The paddock list adds little the map does not already have, so it is
      // mainly a check: does every paddock match, and do the stock numbers
      // worked out here agree with AgriWebb's?
      const stock = new Map(paddockStock((id) => byId.get(id)?.area ?? null, asOf).map((s) => [s.paddock_id, s]));
      const seen = new Set<number>();
      const rows = parsed.paddocks.map((r) => {
        const p = byName.get(normName(r.name));
        const checks: string[] = [];
        if (!p) {
          checks.push("Not on the map");
        } else {
          seen.add(p.row.id);
          const s = stock.get(p.row.id);
          if (r.cattle !== null && s && r.cattle !== s.head) checks.push(`AgriWebb has ${r.cattle} head here; this app has ${s.head}`);
          if (r.cattle && !s) checks.push(`AgriWebb has ${r.cattle} head here; this app has none — import the mob list`);
          if (r.ae !== null && s && Math.abs(r.ae - s.agriwebb_ae) > 0.5) {
            checks.push(`AgriWebb AE ${r.ae.toFixed(1)}; from the mob list ${s.agriwebb_ae.toFixed(1)}`);
          }
        }
        return {
          ...r,
          paddock_id: p?.row.id ?? null,
          map_area_ha: p?.row.area_ha ?? null,
          head_here: p ? stock.get(p.row.id)?.head ?? 0 : null,
          agriwebb_ae_here: p ? stock.get(p.row.id)?.agriwebb_ae ?? 0 : null,
          ae_here: p ? stock.get(p.row.id)?.ae ?? 0 : null,
          ae_per_ha_here: p ? stock.get(p.row.id)?.ae_per_ha ?? 0 : null,
          checks,
        };
      });
      const missing = [...byId.values()].filter((p) => !seen.has(p.row.id)).map((p) => p.row.name);
      const id = storePreview(req, filename, "agriwebb-paddocks", { asOf, rows });
      res.json({ importId: id, type: "paddocks", asOf, rows, missingFromSheet: missing });
    } catch (e) {
      if (e instanceof ImportError) { res.status(400).json({ error: e.message }); return; }
      log.error("records preview failed", e);
      res.status(500).json({ error: "Something went wrong reading that file" });
    }
  }
);

function storePreview(req: Request, filename: string, format: string, payload: unknown): number {
  db.prepare("DELETE FROM imports WHERE status = 'preview' AND ts < ?").run(Date.now() - 86_400_000);
  const r = db.prepare(`
    INSERT INTO imports (ts, username, filename, format, status, payload) VALUES (?, ?, ?, ?, 'preview', ?)
  `).run(Date.now(), who(req), filename, format, JSON.stringify(payload));
  return Number(r.lastInsertRowid);
}

stockApi.post("/import/records/:id/commit", requireAdmin, (req, res) => {
  const id = Number(req.params["id"]);
  const row = db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as ImportRow | undefined;
  if (!row || row.status !== "preview" || !row.format.startsWith("agriwebb-")) {
    res.status(404).json({ error: "That import has expired or was already used. Upload the file again." });
    return;
  }

  try {
    const created = row.format === "agriwebb-mobs"
      ? commitMobs(row, req.body, who(req))
      : row.format === "agriwebb-movements"
        ? commitMovements(row, who(req))
        : row.format === "agriwebb-rainfall"
          ? commitRainfall(row, req.body, who(req))
          : commitPaddocks(row, who(req));
    db.prepare("UPDATE imports SET status = 'committed', committed_at = ? WHERE id = ?").run(Date.now(), id);
    addEvent({
      ts: Date.now(), source: "stock", kind: "import", severity: "info",
      message: `${who(req)} imported ${row.filename}: ${created.summary}`, value: null,
    });
    log.info(`${who(req)} imported ${row.filename}: ${created.summary}`);
    res.json({ ok: true, ...created });
  } catch (e) {
    if (e instanceof ImportError) { res.status(400).json({ error: e.message }); return; }
    log.error("records commit failed", e);
    res.status(500).json({ error: "Something went wrong saving the import" });
  }
});

function commitMobs(row: ImportRow, body: unknown, username: string | null) {
  const { asOf, mobs } = JSON.parse(row.payload) as { asOf: string; mobs: MobCandidate[] };
  const decisions = (body as { items?: unknown })?.items;
  if (!Array.isArray(decisions)) throw new ImportError("Bad request");
  const byI = new Map(mobs.map((m) => [m.i, m]));
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

  const chosen = (decisions as Array<Record<string, unknown>>)
    .map((d) => ({ d, m: byI.get(Number(d["i"])) }))
    .filter((x): x is { d: Record<string, unknown>; m: MobCandidate } => !!x.m);
  if (chosen.length === 0) throw new ImportError("Nothing was selected to import");

  const source = `import:${row.id}`;
  const ids = db.transaction(() => chosen.map(({ d, m }) => {
    const events: EventInput[] = [{
      date: asOf,
      kind: "opening",
      head: m.head,
      paddock_ids: m.paddock_ids,
      data: { agriwebb_paddocks: m.paddock_names },
    }];
    if (m.weight_kg !== null) {
      events.push({
        date: m.last_weighed ?? asOf, kind: "weigh", weight_kg: m.weight_kg, adg_kg: m.adg_kg,
        data: { from: "AgriWebb mob list" },
      });
    }
    return createMobWithEvents({
      name: clean(d["name"]) ?? m.name,
      species: m.species,
      breed: m.breed,
      age_class: m.age_class,
      sex: ["female", "male", "steer"].includes(String(d["sex"])) ? String(d["sex"]) : m.sex,
      tag_colour: m.tag_colour,
      management_tag: m.management_tag,
      origin: m.origin,
      birth_date: m.birth_date,
      description: m.description,
      owner: "owner" in d ? clean(d["owner"]) : m.owner,
      data: {
        agriwebb_key: mobKey(m),
        agriwebb_name: m.source_name,
        agriwebb_ae_head: m.agriwebb_ae_head,
        agriwebb_est_weight_kg: m.agriwebb_est_weight_kg,
        condition_score: m.score,
        cell: m.cell,
        imported_from: row.filename,
      },
    }, events, source, username);
  }))();
  const head = chosen.reduce((s, { m }) => s + m.head, 0);
  return { created: ids.length, summary: `${ids.length} mobs, ${head} head` };
}

/**
 * Readings go in under the gauge names chosen in the review — AgriWebb's
 * "Unknown" can become "Homestead" — and any reading already recorded for
 * that gauge, date, time and amount is skipped.
 */
function commitRainfall(row: ImportRow, body: unknown, username: string | null) {
  const { readings } = JSON.parse(row.payload) as { readings: RainRow[] };
  const names = ((body as { gauges?: unknown })?.gauges ?? {}) as Record<string, unknown>;
  const source = `import:${row.id}`;
  return db.transaction(() => {
    let added = 0, skipped = 0;
    const ids = new Map<string, number>();
    for (const r of readings) {
      const target = typeof names[r.gauge] === "string" && (names[r.gauge] as string).trim()
        ? (names[r.gauge] as string).trim() : r.gauge;
      let gid = ids.get(r.gauge);
      if (gid === undefined) { gid = ensureGauge(target); ids.set(r.gauge, gid); }
      if (readingExists(gid, r.date, r.time, r.mm)) { skipped++; continue; }
      addReading(gid, r.date, r.time, r.mm, null, source, username);
      added++;
    }
    return {
      created: added,
      summary: `${added} rain reading${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already recorded, skipped)` : ""}`,
    };
  })();
}

function commitMovements(row: ImportRow, username: string | null) {
  const { movements } = JSON.parse(row.payload) as { movements: MovementRow[] };
  const { byName } = paddockIndex();
  const lookup = (n: string) => byName.get(normName(n))?.row.id ?? null;
  // Replayed again rather than trusted from the preview: the mobs may have
  // changed in between, and the check against them is the whole safeguard.
  const replay = replayMovements(movements);
  const plan = planHistory(replay, lookup);
  const r = commitHistory(replay, plan, row.id, (n) => lookup(n)!, username);
  return {
    created: r.eventsWritten,
    summary: `movement history: ${r.eventsWritten} events across ${plan.matched.length} current and ${r.mobsCreated} past mobs`,
  };
}

/** The paddock list only fills gaps: descriptions become notes where there are none. */
function commitPaddocks(row: ImportRow, username: string | null) {
  const { rows } = JSON.parse(row.payload) as { rows: Array<PaddockRowCandidate & { paddock_id: number | null }> };
  const { byId } = paddockIndex();
  let updated = 0;
  for (const r of rows) {
    if (r.paddock_id === null || !r.description) continue;
    const p = byId.get(r.paddock_id);
    if (!p || p.props["notes"]) continue;
    updateFeature(p.row.id, {
      kind: p.row.kind, name: p.row.name, subtype: p.row.subtype,
      props: { ...p.props, notes: r.description },
      geometry: JSON.parse(p.row.geometry),
    }, p.row.rev, username);
    updated++;
  }
  return { created: updated, summary: `${updated} paddock note${updated === 1 ? "" : "s"} added` };
}
