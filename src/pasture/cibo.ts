/**
 * Cibo Labs pasture reports.
 *
 * The free Pasture Biomass Report comes as a zip: a monthly CSV of the whole
 * farm's total standing dry matter (TSDM) back to 2017, the farm boundary Cibo
 * used, charts and a PDF. Only the CSV and the boundary are read. The CSV can
 * also be given on its own.
 *
 * TSDM is everything standing — green and dead grass, and some browse — in kg
 * of dry matter per hectare, estimated from satellite imagery.
 */
import { strFromU8, unzipSync } from "fflate";
import type { MultiPolygon, Polygon } from "geojson";
import { db, getSetting, setSetting } from "../db/database.js";
import { areaM2 } from "../map/geometry.js";
import turfIntersect from "@turf/intersect";
import { feature, featureCollection } from "@turf/helpers";

export class PastureError extends Error {}

export interface FarmReading {
  date: string;
  mean: number | null; p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null;
  growth: number | null;
  ref_p25: number | null; ref_p50: number | null; ref_p75: number | null;
  rain: number | null;
}

export interface CiboReport {
  readings: FarmReading[];
  boundary: Polygon | MultiPolygon | null;
}

const SOURCE = "cibo-farm-report";

/** A CSV with plain numeric fields; columns are found by heading. */
function parseTsdmCsv(text: string): FarmReading[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const at = (n: string) => head.indexOf(n);
  if (at("date") < 0 || at("farm_tsdm_mean") < 0) {
    throw new PastureError("This isn't a Cibo Labs pasture report: there's no farm_tsdm_mean column.");
  }
  const cols = {
    mean: at("farm_tsdm_mean"), p10: at("farm_tsdm_p10"), p25: at("farm_tsdm_p25"), p50: at("farm_tsdm_p50"),
    p75: at("farm_tsdm_p75"), p90: at("farm_tsdm_p90"), growth: at("farm_tsdm_growth_mean"),
    ref_p25: at("reference_tsdm_p25"), ref_p50: at("reference_tsdm_p50"), ref_p75: at("reference_tsdm_p75"),
    rain: at("rainfall"),
  };
  const out: FarmReading[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const date = (c[at("date")] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const n = (i: number) => {
      if (i < 0 || (c[i] ?? "").trim() === "") return null;
      const v = Number(c[i]);
      return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
    };
    out.push({
      date, mean: n(cols.mean), p10: n(cols.p10), p25: n(cols.p25), p50: n(cols.p50), p75: n(cols.p75), p90: n(cols.p90),
      growth: n(cols.growth), ref_p25: n(cols.ref_p25), ref_p50: n(cols.ref_p50), ref_p75: n(cols.ref_p75), rain: n(cols.rain),
    });
  }
  if (!out.length) throw new PastureError("The report has no dated rows.");
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------ PastureKey ------------------------------ */

/**
 * One PastureKey reading for one paddock. PastureKey estimates every paddock
 * every five days or so; on a cloudy pass "captured" is low and the figure
 * leans on the model more than on what the satellite saw.
 */
export interface PaddockReading {
  paddock: string;
  area_ha: number | null;
  date: string;
  tsdm: number;
  error: number | null;
  change_rate: number | null;
  captured_pct: number | null;
  green: number | null;
  green_change_rate: number | null;
}

const isPastureKeyHeader = (h: string) => /^paddock,farm,area,/i.test(h.trim());

/**
 * PastureKey's paddock time series ("PaddocksTsdmTimeSeriesAll"): one row per
 * paddock, and for each pass a group of columns suffixed with its date —
 * median_20260926, median_error_20260926, change_rate_…, captured_…,
 * greenmedian_…, green_change_rate_…. Passes with no estimate are left empty.
 */
function parsePastureKeyCsv(text: string): PaddockReading[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const col = new Map(head.map((h, i) => [h, i]));
  const dates = head.filter((h) => /^median_\d{8}$/.test(h)).map((h) => h.slice(7));
  const out: PaddockReading[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const paddock = (c[col.get("paddock")!] ?? "").trim();
    if (!paddock) continue;
    const area = Number(c[col.get("area")!]);
    const n = (name: string) => {
      const i = col.get(name);
      if (i === undefined || (c[i] ?? "").trim() === "") return null;
      const v = Number(c[i]);
      return Number.isFinite(v) ? v : null;
    };
    for (const d of dates) {
      const tsdm = n(`median_${d}`);
      if (tsdm === null) continue;
      const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
      out.push({
        paddock, area_ha: Number.isFinite(area) ? area : null,
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        tsdm, error: n(`median_error_${d}`), change_rate: r1(n(`change_rate_${d}`)),
        captured_pct: n(`captured_${d}`), green: n(`greenmedian_${d}`), green_change_rate: r1(n(`green_change_rate_${d}`)),
      });
    }
  }
  if (!out.length) throw new PastureError("No paddock readings in this file.");
  return out;
}

export type CiboUpload =
  | ({ kind: "farm-report" } & CiboReport)
  | { kind: "pasturekey"; readings: PaddockReading[] };

/** Either Cibo download: the farm report, or PastureKey's paddock time series. */
export function parseCiboUpload(filename: string, buf: Buffer): CiboUpload {
  if (/\.csv$/i.test(filename)) {
    const text = buf.toString("utf8");
    return isPastureKeyHeader(text.slice(0, 200))
      ? { kind: "pasturekey", readings: parsePastureKeyCsv(text) }
      : { kind: "farm-report", readings: parseTsdmCsv(text), boundary: null };
  }
  if (!/\.zip$/i.test(filename)) throw new PastureError("Choose the .zip Cibo Labs sends, or a .csv from inside it.");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch {
    throw new PastureError("That zip file couldn't be opened.");
  }
  // PastureKey splits its time series into a CSV per year.
  const pk = Object.entries(files).filter(([n, b]) => /\.csv$/i.test(n) && isPastureKeyHeader(strFromU8(b.subarray(0, 200))));
  if (pk.length) return { kind: "pasturekey", readings: pk.flatMap(([, b]) => parsePastureKeyCsv(strFromU8(b))) };
  const csvName = Object.keys(files).find((n) => /tsdm_report\.csv$/i.test(n));
  if (!csvName) {
    const hint = Object.keys(files).some((n) => /farm-key/i.test(n))
      ? " That one looks like the Farm Key (the property boundary), which has no pasture figures."
      : "";
    throw new PastureError(`No pasture figures in this zip (no _tsdm_report.csv).${hint}`);
  }
  const readings = parseTsdmCsv(strFromU8(files[csvName]!));

  let boundary: Polygon | MultiPolygon | null = null;
  const gjName = Object.keys(files).find((n) => /\.geojson$/i.test(n));
  if (gjName) {
    try {
      const gj = JSON.parse(strFromU8(files[gjName]!)) as Record<string, { features?: Array<{ geometry?: Polygon | MultiPolygon }> }>;
      const g = gj["farm_geojson"]?.features?.[0]?.geometry;
      if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) boundary = g;
    } catch { /* the readings are what matter; the boundary is a bonus */ }
  }
  return { kind: "farm-report", readings, boundary };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Which app paddock each PastureKey paddock name is. */
function paddockIndex(): Map<string, { id: number; name: string; area_ha: number | null }> {
  const rows = db.prepare("SELECT id, name, area_ha FROM features WHERE kind = 'paddock' AND deleted_at IS NULL")
    .all() as Array<{ id: number; name: string; area_ha: number | null }>;
  return new Map(rows.map((r) => [norm(r.name), r]));
}

const PK = "cibo-pasturekey";

export function previewPastureKey(readings: PaddockReading[]) {
  const index = paddockIndex();
  const names = [...new Set(readings.map((r) => r.paddock))];
  const unmatched = names.filter((n) => !index.has(norm(n)));
  const areaOff = names.flatMap((n) => {
    const p = index.get(norm(n));
    const r = readings.find((x) => x.paddock === n)!;
    if (!p || !p.area_ha || !r.area_ha) return [];
    const off = (r.area_ha - p.area_ha) / p.area_ha;
    return Math.abs(off) > 0.05 ? [{ name: p.name, app_ha: Math.round(p.area_ha), cibo_ha: Math.round(r.area_ha) }] : [];
  });
  const have = new Set((db.prepare("SELECT feature_id || '|' || date AS k FROM pasture_obs WHERE source = ?").all(PK) as Array<{ k: string }>).map((x) => x.k));
  let fresh = 0, matchedReadings = 0;
  for (const r of readings) {
    const p = index.get(norm(r.paddock));
    if (!p) continue;
    matchedReadings++;
    if (!have.has(`${p.id}|${r.date}`)) fresh++;
  }
  const dates = [...new Set(readings.map((r) => r.date))].sort();
  return {
    kind: "pasturekey" as const,
    paddocks: names.length,
    matched: names.length - unmatched.length,
    unmatched,
    area_off: areaOff,
    passes: dates.length,
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    readings: matchedReadings,
    new: fresh,
    updated: matchedReadings - fresh,
  };
}

export function commitPastureKey(readings: PaddockReading[], filename: string): { added: number; updated: number; skipped: number } {
  const p = previewPastureKey(readings);
  const index = paddockIndex();
  const now = Date.now();
  const up = db.prepare(`
    INSERT INTO pasture_obs (feature_id, date, source, tsdm_p50, tsdm_error, change_rate, captured_pct, green, green_change_rate,
      import_file, created_at, updated_at)
    VALUES (@fid, @date, '${PK}', @tsdm, @error, @change_rate, @captured_pct, @green, @green_change_rate, @file, @now, @now)
    ON CONFLICT(feature_id, date, source) DO UPDATE SET
      tsdm_p50 = excluded.tsdm_p50, tsdm_error = excluded.tsdm_error, change_rate = excluded.change_rate,
      captured_pct = excluded.captured_pct, green = excluded.green, green_change_rate = excluded.green_change_rate,
      import_file = excluded.import_file, updated_at = excluded.updated_at
  `);
  let skipped = 0;
  db.transaction(() => {
    for (const r of readings) {
      const pad = index.get(norm(r.paddock));
      if (!pad) { skipped++; continue; }
      up.run({ fid: pad.id, date: r.date, tsdm: r.tsdm, error: r.error, change_rate: r.change_rate, captured_pct: r.captured_pct,
        green: r.green, green_change_rate: r.green_change_rate, file: filename, now });
    }
  })();
  return { added: p.new, updated: p.updated, skipped };
}

export interface PaddockLatest {
  feature_id: number; date: string; tsdm: number; error: number | null; green: number | null;
  change_rate: number | null; captured_pct: number | null; month_ago: number | null;
}

/** The newest PastureKey reading for each paddock, with the reading about a month before it. */
export function paddockLatest(): PaddockLatest[] {
  const rows = db.prepare(`
    SELECT o.feature_id, o.date, o.tsdm_p50 AS tsdm, o.tsdm_error AS error, o.green, o.change_rate, o.captured_pct,
      (SELECT p.tsdm_p50 FROM pasture_obs p WHERE p.feature_id = o.feature_id AND p.source = o.source
         AND p.date <= date(o.date, '-28 days') ORDER BY p.date DESC LIMIT 1) AS month_ago
    FROM pasture_obs o
    WHERE o.source = ? AND o.feature_id != 0
      AND o.date = (SELECT MAX(date) FROM pasture_obs m WHERE m.feature_id = o.feature_id AND m.source = o.source)
  `).all(PK) as PaddockLatest[];
  return rows;
}

export function paddockSeries(featureId: number) {
  return db.prepare(`
    SELECT date, tsdm_p50 AS tsdm, tsdm_error AS error, green, change_rate, captured_pct
    FROM pasture_obs WHERE feature_id = ? AND source = ? ORDER BY date
  `).all(featureId, PK);
}

/** What importing this report would change. */
export function previewCibo(r: CiboReport) {
  const have = new Set((db.prepare("SELECT date FROM pasture_obs WHERE feature_id = 0 AND source = ?").all(SOURCE) as Array<{ date: string }>).map((x) => x.date));
  const fresh = r.readings.filter((x) => !have.has(x.date)).length;
  return {
    months: r.readings.length,
    from: r.readings[0]!.date,
    to: r.readings[r.readings.length - 1]!.date,
    new: fresh,
    updated: r.readings.length - fresh,
    latest: r.readings[r.readings.length - 1]!,
    boundary_ha: r.boundary ? Math.round(areaM2(r.boundary) / 10_000) : null,
    coverage: r.boundary ? coverage(r.boundary) : null,
  };
}

export function commitCibo(r: CiboReport, filename: string): { added: number; updated: number } {
  const p = previewCibo(r);
  const now = Date.now();
  const up = db.prepare(`
    INSERT INTO pasture_obs (feature_id, date, source, tsdm_mean, tsdm_p10, tsdm_p25, tsdm_p50, tsdm_p75, tsdm_p90,
      growth, ref_p25, ref_p50, ref_p75, rain, import_file, created_at, updated_at)
    VALUES (0, @date, '${SOURCE}', @mean, @p10, @p25, @p50, @p75, @p90, @growth, @ref_p25, @ref_p50, @ref_p75, @rain, @file, @now, @now)
    ON CONFLICT(feature_id, date, source) DO UPDATE SET
      tsdm_mean = excluded.tsdm_mean, tsdm_p10 = excluded.tsdm_p10, tsdm_p25 = excluded.tsdm_p25, tsdm_p50 = excluded.tsdm_p50,
      tsdm_p75 = excluded.tsdm_p75, tsdm_p90 = excluded.tsdm_p90, growth = excluded.growth, ref_p25 = excluded.ref_p25,
      ref_p50 = excluded.ref_p50, ref_p75 = excluded.ref_p75, rain = excluded.rain, import_file = excluded.import_file,
      updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    for (const x of r.readings) up.run({ ...x, file: filename, now });
    if (r.boundary) setSetting("cibo_farm_boundary", JSON.stringify(r.boundary));
  })();
  return { added: p.new, updated: p.updated };
}

export function ciboBoundary(): Polygon | MultiPolygon | null {
  const s = getSetting("cibo_farm_boundary");
  return s ? (JSON.parse(s) as Polygon | MultiPolygon) : null;
}

export interface Coverage {
  boundary_ha: number;
  paddock_ha: number;
  covered_ha: number;
  /** Paddocks less than 90% inside Cibo's boundary, least covered first. */
  short: Array<{ id: number; name: string; area_ha: number; share: number }>;
}

/** How much of each paddock lies inside Cibo's farm boundary. */
export function coverage(boundary: Polygon | MultiPolygon): Coverage {
  const rows = db.prepare(
    "SELECT id, name, area_ha, geometry FROM features WHERE kind = 'paddock' AND deleted_at IS NULL"
  ).all() as Array<{ id: number; name: string; area_ha: number | null; geometry: string }>;
  const b = feature(boundary);
  let paddockHa = 0, coveredHa = 0;
  const short: Coverage["short"] = [];
  for (const r of rows) {
    const g = JSON.parse(r.geometry) as Polygon | MultiPolygon;
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") continue;
    const area = r.area_ha ?? areaM2(g) / 10_000;
    let inside = 0;
    try {
      const x = turfIntersect(featureCollection([feature(g), b]));
      inside = x ? areaM2(x.geometry) / 10_000 : 0;
    } catch { inside = 0; }
    const share = area > 0 ? Math.min(1, inside / area) : 0;
    paddockHa += area;
    coveredHa += area * share;
    if (share < 0.9) short.push({ id: r.id, name: r.name, area_ha: Math.round(area), share: Math.round(share * 100) / 100 });
  }
  short.sort((a, b2) => a.share - b2.share || b2.area_ha - a.area_ha);
  return { boundary_ha: Math.round(areaM2(boundary) / 10_000), paddock_ha: Math.round(paddockHa), covered_ha: Math.round(coveredHa), short };
}

export function farmReadings() {
  return db.prepare(`
    SELECT date, tsdm_mean AS mean, tsdm_p10 AS p10, tsdm_p25 AS p25, tsdm_p50 AS p50, tsdm_p75 AS p75, tsdm_p90 AS p90,
      growth, ref_p25, ref_p50, ref_p75, rain, import_file, updated_at
    FROM pasture_obs WHERE feature_id = 0 AND source = ? ORDER BY date
  `).all(SOURCE);
}
