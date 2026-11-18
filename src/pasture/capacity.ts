/**
 * Long-term carrying capacity, paddock by paddock, from FORAGE's paddock
 * report (CarryingCapacityFor_Paddock_LandType_dataOutput_*.csv): for each
 * paddock, the land types in it and the AE each can carry year in, year out
 * in A condition (good land condition) without running the country down.
 *
 * Land condition is the farm's own call. FORAGE assumes A everywhere; David
 * sets the share of each paddock in A, B, C or D, and the capacity drops as
 * FORAGE's own spreadsheet does it: B carries 75% of A, C 45%, D 20%.
 *
 * Set against it is what the paddock has actually carried: its AE-days over
 * the last 12 months, divided by 365. A paddock in a rotation carries far
 * more than its capacity while it's grazed and none while it rests; over a
 * year the average should sit at or under the line.
 *
 * The planner uses it too: a rest on poorer country (more hectares to the AE)
 * counts for less, because the pasture there grows back more slowly.
 */
import { db, getSetting, setSetting } from "../db/database.js";
import { allSegments, mobViews, today } from "../stock/store.js";
import { aePerHead } from "./model.js";

export class CapacityError extends Error {}

export interface LandType {
  code: string; name: string; ha: number; utilisation_pct: number; share_pct: number;
  fpc_pct: number; ae: number; ha_per_ae: number; growth: number;
}
export interface PaddockLtcc { name: string; paddock_id: number | null; land_types: LandType[] }
export interface LtccUpload { kind: "ltcc"; paddocks: PaddockLtcc[]; report_date: string | null; filename: string }
export interface Condition { a: number; b: number; c: number; d: number }

const KEY = "forage_ltcc";
const COND_KEY = "paddock_condition";
const WEIGHT = { a: 1, b: 0.75, c: 0.45, d: 0.2 } as const;

export const isLtccFile = (name: string) => /^CarryingCapacityFor_Paddock_LandType_dataOutput.*\.csv$/i.test(name);

/** "11&12" and FORAGE's "1112", "No.13" and "No13", are the same paddock. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function paddocks() {
  return db.prepare("SELECT id, name, subtype, area_ha FROM features WHERE kind = 'paddock' AND deleted_at IS NULL")
    .all() as Array<{ id: number; name: string; subtype: string | null; area_ha: number | null }>;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
function reportDate(name: string): string | null {
  const m = /_(\d{1,2})([A-Za-z]{3})(\d{4})\.csv$/i.exec(name);
  const mm = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  return m && mm ? `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}` : null;
}

export function parseLtcc(filename: string, buf: Buffer): LtccUpload {
  const lines = buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/);
  if (!/^\s*Paddocks\s*,\s*Land type code/i.test(lines[0] ?? "")) {
    throw new CapacityError("That doesn't look like FORAGE's paddock carrying capacity file (CarryingCapacityFor_Paddock_LandType_dataOutput…csv)");
  }
  const byName = new Map(paddocks().map((p) => [key(p.name), p.id]));
  const out: PaddockLtcc[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",").map((x) => x.trim());
    if (c.length < 11 || !/^[A-Z]{2}\d+$/.test(c[1] ?? "")) continue;
    const n = (i: number) => { const v = Number(c[i]); return Number.isFinite(v) ? v : 0; };
    // A blank first cell is another land type in the paddock above.
    if (c[0]) out.push({ name: c[0], paddock_id: byName.get(key(c[0])) ?? null, land_types: [] });
    const p = out[out.length - 1];
    if (!p) continue;
    p.land_types.push({
      code: c[1]!, name: c[2]!, ha: n(3), utilisation_pct: n(4), share_pct: n(5), fpc_pct: n(6),
      ae: n(7), ha_per_ae: n(8), growth: n(9),
    });
  }
  if (!out.length) throw new CapacityError("No paddocks found in that file");
  return { kind: "ltcc", paddocks: out, report_date: reportDate(filename), filename };
}

export function previewLtcc(f: LtccUpload) {
  const had = getSetting(KEY);
  const old = had ? (JSON.parse(had) as LtccUpload) : null;
  const matched = new Set(f.paddocks.map((p) => p.paddock_id).filter((x) => x !== null));
  return {
    kind: "forage", forage: "ltcc", report_date: f.report_date,
    replaces: old?.report_date ?? (old ? "an earlier report" : null),
    paddocks: f.paddocks.length,
    ae: Math.round(f.paddocks.reduce((t, p) => t + p.land_types.reduce((s, l) => s + l.ae, 0), 0)),
    unmatched: f.paddocks.filter((p) => p.paddock_id === null).map((p) => p.name),
    // Paddocks on the map FORAGE wasn't given: yards and management areas, usually.
    missing: paddocks().filter((p) => !matched.has(p.id)).map((p) => p.name).sort(),
  };
}

export function commitLtcc(f: LtccUpload) {
  setSetting(KEY, JSON.stringify(f));
  return { saved: "ltcc" };
}

function conditions(): Record<string, Condition> {
  const s = getSetting(COND_KEY);
  return s ? (JSON.parse(s) as Record<string, Condition>) : {};
}

export function setCondition(paddockId: number, input: Partial<Record<keyof Condition, unknown>>): Condition {
  if (!paddocks().some((p) => p.id === paddockId)) throw new CapacityError("No such paddock");
  const v = (x: unknown) => {
    const n = Math.round(Number(x ?? 0));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new CapacityError("Each share must be between 0 and 100%");
    return n;
  };
  const c = { a: v(input.a), b: v(input.b), c: v(input.c), d: v(input.d) };
  if (c.a + c.b + c.c + c.d !== 100) throw new CapacityError("The shares in A, B, C and D must add up to 100%");
  const all = conditions();
  if (c.a === 100) delete all[paddockId];
  else all[paddockId] = c;
  setSetting(COND_KEY, JSON.stringify(all));
  return c;
}

const condFactor = (c: Condition | undefined) =>
  c ? (c.a * WEIGHT.a + c.b * WEIGHT.b + c.c * WEIGHT.c + c.d * WEIGHT.d) / 100 : 1;

function stored(): LtccUpload | null {
  const s = getSetting(KEY);
  return s ? (JSON.parse(s) as LtccUpload) : null;
}

/**
 * Average AE each paddock carried over the last 365 days: each mob's AE that
 * day (from its weight) spread over the paddocks it could reach, by area.
 */
function aeLastYear(): Map<number, number> {
  const area = new Map(paddocks().map((p) => [p.id, p.area_ha ?? 0]));
  const DAY = 86_400_000;
  const now = Math.round(Date.parse(`${today()}T00:00:00Z`) / DAY);
  const start = now - 365;
  const aeOf = aePerHead();
  const total = new Map<number, number>();
  for (const s of allSegments()) {
    if (s.head <= 0 || !s.paddock_ids.length) continue;
    const from = Math.max(start, Math.round(Date.parse(`${s.from}T00:00:00Z`) / DAY));
    const to = Math.min(now, s.to ? Math.round(Date.parse(`${s.to}T00:00:00Z`) / DAY) : now);
    if (to <= from) continue;
    let aeDays = 0;
    for (let d = from; d < to; d++) aeDays += s.head * aeOf(s.mob_id, d);
    const reach = s.paddock_ids.reduce((t, id) => t + (area.get(id) ?? 0), 0);
    for (const id of s.paddock_ids) {
      const share = reach > 0 ? (area.get(id) ?? 0) / reach : 1 / s.paddock_ids.length;
      total.set(id, (total.get(id) ?? 0) + aeDays * share);
    }
  }
  return new Map([...total].map(([id, v]) => [id, v / 365]));
}

/** Capacity for each paddock FORAGE reported, condition applied: { ae, ha_per_ae } by paddock id. */
export function capacityById(): Map<number, { ae: number; ha_per_ae: number }> {
  const f = stored();
  const cond = conditions();
  const out = new Map<number, { ae: number; ha_per_ae: number }>();
  if (!f) return out;
  for (const p of f.paddocks) {
    if (p.paddock_id === null) continue;
    const ha = p.land_types.reduce((t, l) => t + l.ha, 0);
    const ae = p.land_types.reduce((t, l) => t + l.ae, 0) * condFactor(cond[p.paddock_id]);
    if (ae > 0) out.set(p.paddock_id, { ae, ha_per_ae: ha / ae });
  }
  return out;
}

/**
 * How much a rest on each paddock counts for in the planner: 1 on country as
 * good as the farm's middle paddock (by area), less the poorer it is — a
 * paddock needing twice the hectares to the AE counts its rest as half —
 * never below a quarter.
 */
export function restWeights(): { weights: Map<number, number>; ref_ha_per_ae: number | null } {
  const cap = capacityById();
  const graze = paddocks().filter((p) => p.subtype === "grazing" && cap.has(p.id));
  if (!graze.length) return { weights: new Map(), ref_ha_per_ae: null };
  // The area-weighted median: half the grazing country is at or better than this.
  const sorted = graze.map((p) => ({ r: cap.get(p.id)!.ha_per_ae, a: p.area_ha ?? 0 })).sort((x, y) => x.r - y.r);
  const half = sorted.reduce((t, x) => t + x.a, 0) / 2;
  let run = 0, ref = sorted[0]!.r;
  for (const x of sorted) { run += x.a; ref = x.r; if (run >= half) break; }
  const weights = new Map<number, number>();
  for (const [id, c] of cap) weights.set(id, Math.max(0.25, Math.min(1, ref / c.ha_per_ae)));
  return { weights, ref_ha_per_ae: ref };
}

/** The Carrying capacity view: every paddock FORAGE reported, with what it's carrying now and over the year. */
export function capacitySummary() {
  const f = stored();
  if (!f) return null;
  const cond = conditions();
  const pads = new Map(paddocks().map((p) => [p.id, p]));
  const year = aeLastYear();
  const nowAe = new Map<number, number>();
  for (const v of mobViews()) {
    const ids = v.state.paddock_ids;
    if (!ids.length || v.state.head <= 0) continue;
    const ae = v.ae_total ?? v.state.head;
    const reach = ids.reduce((t, id) => t + (pads.get(id)?.area_ha ?? 0), 0);
    for (const id of ids) nowAe.set(id, (nowAe.get(id) ?? 0) + (reach > 0 ? ae * (pads.get(id)?.area_ha ?? 0) / reach : ae / ids.length));
  }
  const { weights } = restWeights();
  const rows = f.paddocks.map((p) => {
    const pad = p.paddock_id !== null ? pads.get(p.paddock_id) : undefined;
    const c = p.paddock_id !== null ? cond[p.paddock_id] : undefined;
    const ha = p.land_types.reduce((t, l) => t + l.ha, 0);
    const aeA = p.land_types.reduce((t, l) => t + l.ae, 0);
    const ae = aeA * condFactor(c);
    const main = [...p.land_types].sort((a, b) => b.ha - a.ha);
    return {
      paddock_id: p.paddock_id, name: pad?.name ?? p.name, subtype: pad?.subtype ?? null, area_ha: pad?.area_ha ?? ha,
      land_types: main.filter((l) => l.share_pct >= 1).map((l) => ({ code: l.code, name: l.name, share_pct: l.share_pct, ha_per_ae: l.ha_per_ae, ae: l.ae, fpc_pct: l.fpc_pct })),
      condition: c ?? { a: 100, b: 0, c: 0, d: 0 },
      ae_a: aeA, ae, ha_per_ae: ae > 0 ? ha / ae : null,
      ae_now: p.paddock_id !== null ? nowAe.get(p.paddock_id) ?? 0 : null,
      ae_year: p.paddock_id !== null ? year.get(p.paddock_id) ?? 0 : null,
      rest_weight: p.paddock_id !== null ? weights.get(p.paddock_id) ?? null : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const sum = (xs: typeof rows, k: "ae" | "ae_a" | "ae_now" | "ae_year") => xs.reduce((t, r) => t + (r[k] ?? 0), 0);
  const graze = rows.filter((r) => r.subtype !== "cultivation");
  const total = [...mobViews()].reduce((t, v) => t + (v.state.head > 0 ? v.ae_total ?? v.state.head : 0), 0);
  return {
    report_date: f.report_date, filename: f.filename,
    paddocks: rows,
    totals: {
      all: { ae: sum(rows, "ae"), ae_a: sum(rows, "ae_a"), ae_year: sum(rows, "ae_year") },
      grazing: { ae: sum(graze, "ae"), ae_a: sum(graze, "ae_a"), ae_year: sum(graze, "ae_year") },
      ae_now: total,
    },
  };
}

/** One paddock's capacity, for the paddock panel. */
export function paddockCapacity(id: number) {
  const s = capacitySummary();
  return s?.paddocks.find((p) => p.paddock_id === id) ?? null;
}
