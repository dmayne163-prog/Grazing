/**
 * FORAGE, the Queensland Government's property reports (Long Paddock): the
 * long view the farm's own records can't give — 50 years of rainfall and
 * GRASP-modelled pasture growth for the property, and satellite ground cover
 * back to 1987.
 *
 * Two of the CSVs a FORAGE request sends are read:
 *  - dataInGraphs_ForageRainfallAndPastureByLandTypeReport_*.csv: annual
 *    (April–March) rainfall and pasture growth, monthly standing dry matter
 *    and modelled ground cover, and seasonal satellite cover;
 *  - ForageGroundCoverReport_coverData_*.csv: seasonal satellite green,
 *    dry and total cover and bare ground.
 *
 * These are whole-property figures. FORAGE's pasture is modelled with an
 * assumed stocking rate, not the mobs actually run here, so it is context
 * ("is this a good year?"), not a reading of feed in a paddock — that is
 * what Cibo's PastureKey readings are for.
 *
 * Each import replaces the last one of its kind: a newer report carries the
 * whole history again.
 */
import { getSetting, setSetting } from "../db/database.js";

export class ForageError extends Error {}

export interface ForageYear { year: number; rain: number | null; growth: number | null }
export interface ForageMonth { month: string; tsdm: number | null; cover: number | null }
export interface ForageSeason { from: string; to: string; green: number | null; dry: number | null; total: number | null; bare: number | null }

export interface ForagePasture { kind: "rainfall-pasture"; years: ForageYear[]; months: ForageMonth[]; report_date: string | null; filename: string }
export interface ForageCover { kind: "cover"; seasons: ForageSeason[]; report_date: string | null; filename: string }
export type ForageUpload = ForagePasture | ForageCover;

export const isForageFile = (name: string) => /forage.*\.csv$/i.test(name);

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** "…_17Nov2026.csv" → "2026-11-17". */
function reportDate(name: string): string | null {
  const m = /_(\d{1,2})([A-Za-z]{3})(\d{4})\.csv$/i.exec(name);
  const mm = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  return m && mm ? `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}` : null;
}

const num = (s: string | undefined) => {
  const v = Number(String(s ?? "").trim());
  return s === undefined || String(s).trim() === "" || !Number.isFinite(v) || v <= -100 ? null : v;
};
const ym = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}`;
const cells = (line: string) => line.split(",").map((c) => c.trim()).filter((c, i, a) => c !== "" || i < a.length - 1);

export function parseForage(filename: string, buf: Buffer): ForageUpload {
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const date = reportDate(filename);

  if (/RainfallAndPasture/i.test(filename) || lines.some((l) => /^Annual \(April - March\) Pasture Growth/i.test(l.trim()))) {
    // Each series is a title line, a line of dates and a line of values.
    const series = (title: RegExp) => {
      const i = lines.findIndex((l) => title.test(l.trim()));
      if (i < 0) return null;
      return { keys: cells(lines[i + 1] ?? ""), vals: cells(lines[i + 2] ?? "") };
    };
    const rain = series(/^Annual \(April - March\) Rainfall/i);
    const growth = series(/^Annual \(April - March\) Pasture Growth/i);
    const tsdm = series(/^Monthly Total Standing Dry Matter/i);
    const cover = series(/^Monthly Ground Cover/i);
    if (!rain || !growth || !tsdm) throw new ForageError("That doesn't look like FORAGE's Rainfall and Pasture data file");
    const years: ForageYear[] = rain.keys.map((k, i) => ({
      year: Number(k), rain: num(rain.vals[i]), growth: num(growth.vals[growth.keys.indexOf(k)]),
    })).filter((y) => Number.isInteger(y.year));
    const coverAt = new Map((cover?.keys ?? []).map((k, i) => [k, num(cover!.vals[i])]));
    const months: ForageMonth[] = tsdm.keys.filter((k) => /^\d{6}$/.test(k)).map((k, i) => ({
      month: ym(k), tsdm: num(tsdm.vals[i]), cover: coverAt.get(k) ?? null,
    }));
    if (!years.length || !months.length) throw new ForageError("No figures found in that FORAGE file");
    return { kind: "rainfall-pasture", years, months, report_date: date, filename };
  }

  if (/GroundCover/i.test(filename) || lines.some((l) => /Satellite based total Cover/i.test(l))) {
    const seasons: ForageSeason[] = [];
    for (const l of lines) {
      const c = l.split(",").map((x) => x.trim());
      if (!/^\d{6}$/.test(c[0] ?? "") || !/^\d{6}$/.test(c[1] ?? "")) continue;
      const total = num(c[4]);
      seasons.push({
        from: ym(c[0]!), to: ym(c[1]!),
        green: total === null ? null : num(c[2]), dry: num(c[3]), total, bare: total === null ? null : num(c[5]),
      });
    }
    if (!seasons.length) throw new ForageError("No ground cover figures found in that FORAGE file");
    return { kind: "cover", seasons, report_date: date, filename };
  }

  throw new ForageError("That FORAGE file isn't one the app reads yet. It reads the Rainfall and Pasture data file (dataInGraphs_…csv) and the Ground Cover data file (…coverData…csv).");
}

const KEY = { "rainfall-pasture": "forage_pasture", cover: "forage_cover" } as const;

export function previewForage(f: ForageUpload) {
  const had = getSetting(KEY[f.kind]);
  const old = had ? (JSON.parse(had) as ForageUpload) : null;
  if (f.kind === "rainfall-pasture") {
    const ys = f.years.filter((y) => y.rain !== null);
    return {
      kind: "forage", forage: f.kind, report_date: f.report_date, replaces: old?.report_date ?? (old ? "an earlier report" : null),
      from: `${ys[0]?.year}`, to: `${ys[ys.length - 1]?.year}`, years: ys.length, months: f.months.length,
    };
  }
  const ok = f.seasons.filter((s) => s.total !== null);
  return {
    kind: "forage", forage: f.kind, report_date: f.report_date, replaces: old?.report_date ?? (old ? "an earlier report" : null),
    from: ok[0]?.from, to: ok[ok.length - 1]?.to, seasons: ok.length,
  };
}

export function commitForage(f: ForageUpload) {
  setSetting(KEY[f.kind], JSON.stringify(f));
  return { saved: f.kind };
}

/** Where a value sits among others: the share of them it's at or above, 0–100. */
function percentile(v: number | null, all: Array<number | null>): number | null {
  const xs = all.filter((x): x is number => x !== null);
  if (v === null || xs.length < 5) return null;
  return Math.round((xs.filter((x) => x <= v).length / xs.length) * 100);
}

/** What the Pasture tab shows: the stored figures, with where this year and season sit. */
export function forageSummary() {
  const p = getSetting(KEY["rainfall-pasture"]);
  const c = getSetting(KEY.cover);
  const pasture = p ? (JSON.parse(p) as ForagePasture) : null;
  const cover = c ? (JSON.parse(c) as ForageCover) : null;
  if (!pasture && !cover) return null;

  let years = null;
  if (pasture) {
    // The last year is April to date, not a full year: ranked only on the full years.
    const full = pasture.years.slice(0, -1);
    const last = full[full.length - 1] ?? null;
    years = {
      list: pasture.years,
      partial: pasture.years[pasture.years.length - 1]?.year ?? null,
      last_full: last && {
        year: last.year, rain: last.rain, growth: last.growth,
        rain_pct: percentile(last.rain, full.map((y) => y.rain)),
        growth_pct: percentile(last.growth, full.map((y) => y.growth)),
      },
    };
  }

  let latestMonth = null;
  if (pasture) {
    const m = [...pasture.months].reverse().find((x) => x.tsdm !== null) ?? null;
    if (m) {
      const same = pasture.months.filter((x) => x.month.slice(5) === m.month.slice(5));
      latestMonth = { ...m, tsdm_pct: percentile(m.tsdm, same.map((x) => x.tsdm)), cover_pct: percentile(m.cover, same.map((x) => x.cover)) };
    }
  }

  let latestSeason = null;
  if (cover) {
    const s = [...cover.seasons].reverse().find((x) => x.total !== null) ?? null;
    if (s) {
      const same = cover.seasons.filter((x) => x.from.slice(5) === s.from.slice(5));
      latestSeason = { ...s, total_pct: percentile(s.total, same.map((x) => x.total)), lowest: Math.min(...cover.seasons.filter((x) => x.total !== null).map((x) => x.total!)) };
    }
  }

  return {
    pasture: pasture && { report_date: pasture.report_date, months: pasture.months },
    cover: cover && { report_date: cover.report_date, seasons: cover.seasons },
    years, latest_month: latestMonth, latest_season: latestSeason,
  };
}
