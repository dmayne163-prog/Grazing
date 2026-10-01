/**
 * The pasture model: how much standing feed each paddock has, day by day, and
 * where it is heading.
 *
 * Two pools, because that is what PastureKey measures and what the country
 * does — total pasture falls in a wet start to summer while the green pick
 * rises, as last year's dead grass breaks down faster than new grass grows:
 *
 *   soil water  W     fills with SILO rain, empties at the rate the air draws
 *                     it (SILO's reference evapotranspiration), faster when wet
 *   green       G  += growth − dying off − eaten
 *       growth        g · m · (W / Wmax) · ET0 · temperature · (1 − total / Bmax)
 *                     (tropical grasses: little below a 12 °C day-night mean,
 *                     full growth from 22 °C, none after a frost)
 *       dying off     s · G · (1 + a · dryness) — faster as the soil dries,
 *                     which is the green haying off at the end of a wet season
 *   dead        Dd += dying off − breakdown − eaten
 *       breakdown     b · Dd + c · Dd · (rain that day, up to 25 mm) / 25 —
 *                     storms knock down and rot last year's grass
 *   eaten             q kg a day for each AE in the paddock, green by preference
 *
 * Total standing dry matter (TSDM) is G + Dd, kg/ha, PastureKey's figure.
 * g, s, a, b and c are fitted (q is fixed: see INTAKE) to PastureKey's green and total readings over
 * the period the movement records cover, by matching the model's 90-day-ahead
 * predictions to what was then measured. m is each paddock's own growth
 * multiplier (soil, land condition, cultivation), pulled towards 1 unless its
 * readings clearly say otherwise.
 *
 * Projections start from each paddock's latest reading, bring it up to
 * yesterday with the weather and stock that actually happened, then run on
 * with the weather of every past year since 1890 from today's date: the spread
 * of outcomes is the spread of seasons this country has had.
 */
import { db, getSetting } from "../db/database.js";
import { paddockCells } from "../climate/silo.js";
import { aeFromWeight, allSegments, mobViews, today } from "../stock/store.js";

/* --------------------------------- dates ---------------------------------- */

const DAY = 86_400_000;
const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/* ------------------------------- constants -------------------------------- */

const WMAX = 100;         // mm of plant-available soil water
const BMAX = 7000;        // kg/ha total at which growth stops
const MIN_POOL = 20;      // kg/ha: neither pool is grazed or rotted below this
const T_LOW = 12, T_HIGH = 22;
const HORIZON = 180;      // days projected
const SPIN_UP = 150;      // days of weather before the first reading, to set soil water
// The calibration matches predictions this far ahead: the horizon an outlook is
// used at. Over 90 days the model beats "no change"; over 30 it barely can.
const LEAD = 90;
const UTILISATION = 0.25; // share of a year's growth that can be eaten without running the country down
/**
 * What one AE eats, kg of dry matter a day: a 450 kg steer at maintenance.
 * Fixed, not fitted: on the first year of readings the fit wanted about half
 * this, which would overstate how long the feed lasts, the dangerous way round.
 */
const INTAKE = 8;
const GREEN_PREFERENCE = 2; // stock take green at twice its share of what's standing

export interface Params { g: number; s: number; a: number; b: number; c: number; q: number }
const DEFAULTS: Params = { g: 12, s: 0.005, a: 3, b: 0.002, c: 0.05, q: INTAKE };

/* -------------------------------- weather --------------------------------- */

interface Weather { start: number; rain: Float64Array; et0: Float64Array; tidx: Float64Array }

function loadWeather(cells: string[], from: number, to: number): Map<string, Weather> {
  const n = to - from + 1;
  const out = new Map<string, Weather>();
  const q = db.prepare("SELECT date, rain, et0, tmax, tmin FROM climate_daily WHERE cell = ? AND date BETWEEN ? AND ? ORDER BY date");
  for (const cell of cells) {
    const w: Weather = { start: from, rain: new Float64Array(n), et0: new Float64Array(n), tidx: new Float64Array(n) };
    let lastEt = 4, lastT = 0.5;
    for (const r of q.iterate(cell, isoOf(from), isoOf(to)) as Iterable<{ date: string; rain: number | null; et0: number | null; tmax: number | null; tmin: number | null }>) {
      const i = dayNo(r.date) - from;
      w.rain[i] = r.rain ?? 0;
      lastEt = r.et0 ?? lastEt;
      w.et0[i] = lastEt;
      if (r.tmax !== null && r.tmin !== null) {
        const mean = (r.tmax + r.tmin) / 2;
        lastT = r.tmin < 0 ? 0 : Math.min(1, Math.max(0, (mean - T_LOW) / (T_HIGH - T_LOW)));
      }
      w.tidx[i] = lastT;
    }
    out.set(cell, w);
  }
  return out;
}

/**
 * The soil-water store over a stretch of weather: each day's growth driver
 * (water index × ET0 × temperature index) and water index, and the store left
 * at the end. It doesn't depend on the pasture, so each grid point is worked
 * out once and shared by its paddocks.
 */
interface Drive { D: Float64Array; WI: Float64Array; R: Float64Array; W: number }
function driver(w: Weather, i0: number, n: number, W0: number): Drive {
  const D = new Float64Array(n), WI = new Float64Array(n), R = new Float64Array(n);
  let W = W0;
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    W = Math.min(WMAX, W + (w.rain[i] ?? 0));
    const wi = W / WMAX;
    D[k] = wi * (w.et0[i] ?? 0) * (w.tidx[i] ?? 0);
    WI[k] = wi;
    R[k] = w.rain[i] ?? 0;
    W = Math.max(0, W - (w.et0[i] ?? 0) * wi);
  }
  return { D, WI, R, W };
}

/** One paddock, one day. Mutates and returns [green, dead]. */
function step(s: Float64Array, p: Params, m: number, D: number, wi: number, rain: number, aePerHa: number): Float64Array {
  let G = s[0]!, Dd = s[1]!;
  const grow = p.g * m * D * Math.max(0, 1 - (G + Dd) / BMAX);
  const die = Math.min(0.5 * G, p.s * G * (1 + p.a * (1 - wi)));
  const rot = Math.min(0.5 * Dd, p.b * Dd + p.c * Dd * Math.min(1, rain / 25));
  const eat = p.q * aePerHa;
  const share = G + Dd > 0 ? Math.min(1, (GREEN_PREFERENCE * G) / (G + Dd)) : 0;
  let eatG = eat * share, eatD = eat - eatG;
  // What can't be had from one pool comes from the other.
  if (G + grow - die - eatG < MIN_POOL) { const short = MIN_POOL - (G + grow - die - eatG); eatG -= short; eatD += short; }
  G = Math.max(MIN_POOL, G + grow - die - eatG);
  Dd = Math.max(MIN_POOL, Dd + die - rot - eatD);
  s[0] = G; s[1] = Dd;
  return s;
}

const startState = (tsdm: number, green: number | null) => {
  const g = green === null ? 0.2 * tsdm : Math.min(tsdm, green);
  return Float64Array.of(Math.max(MIN_POOL, g), Math.max(MIN_POOL, tsdm - g));
};

/* --------------------------------- inputs --------------------------------- */

interface Obs { day: number; tsdm: number; green: number | null; w: number }
interface Paddock {
  id: number; name: string; area: number; cell: string; subtype: string | null;
  obs: Obs[];
  ae: Float64Array; // AE per ha, day by day from the model's start
}

interface Inputs {
  start: number; end: number; // day numbers; end = the last day with weather
  paddocks: Paddock[];
  weather: Map<string, Weather>;
}

/**
 * AE per head for a mob on a given day. For now that's the mob's latest
 * weight (or, for mobs since sold, AgriWebb's figure, else 1 AE a head) for
 * every day. This is the one place an animal's weight on the day — Optiweigh,
 * the scales — will feed in, so intake follows the cattle as they grow.
 */
function aePerHead(): (mobId: number, day: number) => number {
  const byMob = new Map<number, number>();
  for (const v of mobViews(today())) if (v.ae_head !== null) byMob.set(v.mob.id, v.ae_head);
  for (const m of db.prepare("SELECT id, data FROM mobs").all() as Array<{ id: number; data: string }>) {
    if (byMob.has(m.id)) continue;
    const d = JSON.parse(m.data) as Record<string, unknown>;
    const w = typeof d["weight_kg"] === "number" ? aeFromWeight(d["weight_kg"]) : null;
    byMob.set(m.id, w ?? (typeof d["agriwebb_ae_head"] === "number" ? d["agriwebb_ae_head"] : 1));
  }
  return (mobId) => byMob.get(mobId) ?? 1;
}

function loadInputs(): Inputs | null {
  const feats = db.prepare(
    "SELECT id, name, subtype, area_ha FROM features WHERE kind = 'paddock' AND deleted_at IS NULL"
  ).all() as Array<{ id: number; name: string; subtype: string | null; area_ha: number | null }>;
  const cells = paddockCells();
  const obsRows = db.prepare(
    "SELECT feature_id, date, tsdm_p50, green, captured_pct FROM pasture_obs WHERE source = 'cibo-pasturekey' AND feature_id != 0 ORDER BY date"
  ).all() as Array<{ feature_id: number; date: string; tsdm_p50: number; green: number | null; captured_pct: number | null }>;
  if (!obsRows.length) return null;
  const lastWeather = db.prepare("SELECT MIN(last_date) d FROM climate_cells WHERE last_date IS NOT NULL").get() as { d: string | null };
  if (!lastWeather.d) return null;

  const start = dayNo(obsRows[0]!.date) - SPIN_UP;
  const end = dayNo(lastWeather.d);
  const n = end - start + 1;

  const byId = new Map<number, Paddock>();
  for (const f of feats) {
    const cell = cells.get(f.id);
    if (!cell || !f.area_ha) continue;
    byId.set(f.id, { id: f.id, name: f.name, area: f.area_ha, cell, subtype: f.subtype, obs: [], ae: new Float64Array(n) });
  }
  for (const r of obsRows) {
    const p = byId.get(r.feature_id);
    // A clear view counts for more than a cloudy pass Cibo has filled in.
    if (p) p.obs.push({ day: dayNo(r.date), tsdm: r.tsdm_p50, green: r.green, w: 0.3 + 0.7 * Math.min(1, (r.captured_pct ?? 0) / 100) });
  }

  // Stock: each segment's AE spread over the paddocks it could reach, by area.
  const ae = aePerHead();
  for (const s of allSegments()) {
    const a = Math.max(start, dayNo(s.from));
    const b = Math.min(end + 1, s.to ? dayNo(s.to) : end + 1);
    if (b <= a) continue;
    const reach = s.paddock_ids.map((id) => byId.get(id)).filter((p): p is Paddock => !!p);
    const total = reach.reduce((t, p) => t + p.area, 0);
    if (!total) continue;
    for (let d = a; d < b; d++) {
      const perHa = (s.head * ae(s.mob_id, d)) / total; // the same AE/ha in each paddock it can reach
      for (const p of reach) p.ae[d - start]! += perHa;
    }
  }

  const weather = loadWeather([...new Set([...byId.values()].map((p) => p.cell))], start, end);
  return { start, end, paddocks: [...byId.values()], weather };
}

/* ------------------------------ calibration ------------------------------- */

interface Interval { p: Paddock; from: number; to: number; a: Obs; b: Obs; w: number }

/** Every reading paired with the reading about LEAD days later. */
function intervals(inp: Inputs): Interval[] {
  const out: Interval[] = [];
  for (const p of inp.paddocks) {
    for (let i = 0; i < p.obs.length; i++) {
      const a = p.obs[i]!;
      let best: Obs | null = null;
      for (let j = i + 1; j < p.obs.length; j++) {
        const gap = p.obs[j]!.day - a.day;
        if (gap > LEAD + 10) break;
        if (gap >= LEAD - 10 && (!best || Math.abs(gap - LEAD) < Math.abs(best.day - a.day - LEAD))) best = p.obs[j]!;
      }
      if (best) out.push({ p, from: a.day, to: best.day, a, b: best, w: best.w * a.w });
    }
  }
  return out;
}

function predict(iv: Interval, drives: Map<string, Drive>, start: number, p: Params, m: number): Float64Array {
  const dr = drives.get(iv.p.cell)!;
  const s = startState(iv.a.tsdm, iv.a.green);
  for (let t = iv.from; t < iv.to; t++) step(s, p, m, dr.D[t - start]!, dr.WI[t - start]!, dr.R[t - start]!, iv.p.ae[t - start]!);
  return s;
}

/** Squared error on total and on green, each as it was measured. */
function err2(iv: Interval, s: Float64Array): number {
  const eT = s[0]! + s[1]! - iv.b.tsdm;
  const eG = iv.b.green === null ? 0 : s[0]! - iv.b.green;
  return eT * eT + eG * eG;
}

/** Nelder–Mead, minimising f over a few unconstrained variables. */
function nelderMead(f: (x: number[]) => number, x0: number[], scale: number[], iters = 400): number[] {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + scale[j]! : v)))].map((x) => ({ x, v: f(x) }));
  for (let it = 0; it < iters; it++) {
    simplex.sort((a, b) => a.v - b.v);
    const best = simplex[0]!, worst = simplex[n]!, second = simplex[n - 1]!;
    const c = x0.map((_, j) => simplex.slice(0, n).reduce((t, s) => t + s.x[j]!, 0) / n);
    const at = (t: number) => c.map((cj, j) => cj + t * (worst.x[j]! - cj));
    const r = at(-1), fr = f(r);
    if (fr < best.v) {
      const e = at(-2), fe = f(e);
      simplex[n] = fe < fr ? { x: e, v: fe } : { x: r, v: fr };
    } else if (fr < second.v) {
      simplex[n] = { x: r, v: fr };
    } else {
      const ct = at(fr < worst.v ? -0.5 : 0.5), fc = f(ct);
      if (fc < Math.min(fr, worst.v)) simplex[n] = { x: ct, v: fc };
      else simplex = simplex.map((s, i) => (i === 0 ? s : (() => {
        const x = s.x.map((v, j) => best.x[j]! + 0.5 * (v - best.x[j]!));
        return { x, v: f(x) };
      })()));
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return simplex[0]!.x;
}

/* Parameters live on a log scale, so the optimiser can't make them negative, and within sensible bounds. */
const BOUNDS: Record<keyof Params, [number, number]> = {
  g: [1, 60], s: [0.0005, 0.05], a: [0.2, 30], b: [0.0002, 0.02], c: [0.005, 0.5], q: [INTAKE, INTAKE],
};
const KEYS = ["g", "s", "a", "b", "c", "q"] as const;
function toParams(x: number[]): Params {
  const p = {} as Params;
  KEYS.forEach((key, i) => { const [lo, hi] = BOUNDS[key]; p[key] = Math.min(hi, Math.max(lo, Math.exp(x[i]!))); });
  return p;
}

export interface Fit {
  params: Params;
  multipliers: Map<number, number>;
  intervals: number;
  mae: number;             // median absolute error of 90-day predictions of total pasture, kg/ha
  lead: number;            // the prediction horizon those errors are for, days
  bias: number;            // mean (prediction − reading), kg/ha
  persistence_mae: number; // the same for "no change", to show what the model adds
  green_mae: number;
  set_aside: number;       // stretches left out as measurement artefacts
}

function artefact(iv: Interval, drives: Map<string, Drive>, start: number): boolean {
  if (iv.b.tsdm - iv.a.tsdm <= 100) return false;
  const greenRise = iv.a.green !== null && iv.b.green !== null ? iv.b.green - iv.a.green : 0;
  const R = drives.get(iv.p.cell)!.R;
  let rain = 0;
  for (let t = iv.from; t < iv.to; t++) rain += R[t - start]!;
  return greenRise < 20 && rain < 10;
}

function calibrate(inp: Inputs): Fit | null {
  const drives = new Map<string, Drive>();
  for (const [cell, w] of inp.weather) drives.set(cell, driver(w, 0, inp.end - inp.start + 1, WMAX * 0.3));
  // Standing dry matter can't rise without growth. Where PastureKey's total
  // climbed with no green growth and next to no rain — the dry winter of 2026
  // read that way as the grass cured — the reading is set aside, not fitted.
  const all = intervals(inp);
  const ivs = all.filter((iv) => !artefact(iv, drives, inp.start));
  const setAside = all.length - ivs.length;
  if (ivs.length < 20) return null;

  const loss = (p: Params) => ivs.reduce((t, iv) => t + iv.w * err2(iv, predict(iv, drives, inp.start, p, 1)), 0);
  const x = nelderMead((xv) => loss(toParams(xv)), KEYS.map((k) => Math.log(DEFAULTS[k])), [0.6, 0.6, 0.6, 0.6, 0.6, 0.3], 600);
  const params = toParams(x);

  // Each paddock's own growth multiplier, shrunk towards 1: golden-section search.
  const multipliers = new Map<number, number>();
  const byPaddock = new Map<number, Interval[]>();
  for (const iv of ivs) byPaddock.set(iv.p.id, [...(byPaddock.get(iv.p.id) ?? []), iv]);
  for (const [id, list] of byPaddock) {
    const scale = list.reduce((t, iv) => t + iv.w * iv.b.tsdm * iv.b.tsdm, 0) / list.length;
    const f = (m: number) => list.reduce((t, iv) => t + iv.w * err2(iv, predict(iv, drives, inp.start, params, m)), 0) + 0.25 * scale * (m - 1) ** 2;
    let a = 0.3, b = 3;
    const phi = (Math.sqrt(5) - 1) / 2;
    for (let it = 0; it < 40; it++) {
      const c = b - phi * (b - a), d = a + phi * (b - a);
      if (f(c) < f(d)) b = d; else a = c;
    }
    multipliers.set(id, Math.round(((a + b) / 2) * 100) / 100);
  }

  const preds = ivs.map((iv) => predict(iv, drives, inp.start, params, multipliers.get(iv.p.id) ?? 1));
  const errs = preds.map((s, i) => s[0]! + s[1]! - ivs[i]!.b.tsdm);
  const gErrs = preds.flatMap((s, i) => (ivs[i]!.b.green === null ? [] : [Math.abs(s[0]! - ivs[i]!.b.green!)]));
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : 0; };
  return {
    params: { g: round(params.g, 2), s: round(params.s, 4), a: round(params.a, 2), b: round(params.b, 4), c: round(params.c, 3), q: round(params.q, 2) },
    multipliers,
    intervals: ivs.length,
    set_aside: setAside,
    lead: LEAD,
    mae: Math.round(med(errs.map(Math.abs))),
    bias: Math.round(errs.reduce((t, e) => t + e, 0) / errs.length),
    persistence_mae: Math.round(med(ivs.map((iv) => Math.abs(iv.a.tsdm - iv.b.tsdm)))),
    green_mae: Math.round(med(gErrs)),
  };
}

const round = (v: number, n: number) => Math.round(v * 10 ** n) / 10 ** n;

/* ------------------------------ projections ------------------------------- */

const STEP = 3; // days between stored points of a projection
const pct = (xs: ArrayLike<number>, p: number) => {
  const s = Array.from(xs).sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[i]!;
};

export interface PaddockOutlook {
  id: number;
  name: string;
  subtype: string | null;
  area_ha: number;
  multiplier: number | null;
  last_reading: { date: string; tsdm: number; green: number | null } | null;
  now: number | null;                 // estimate of total pasture for today, kg/ha
  now_green: number | null;
  ae_per_ha: number;                  // stock in the paddock now
  /** Days until the paddock reaches the residual with today's stock: low, median and high outcomes across past seasons (20th, 50th, 80th percentile). Null: not within the horizon. */
  days_left: { low: number | null; median: number | null; high: number | null } | null;
  at: Record<"30" | "90" | "180", { low: number; median: number; high: number }> | null;
  /** Long-term AE the paddock carries at the safe utilisation. */
  capacity_ae: number | null;
  series: Array<{ date: string; p10: number; p20: number; p50: number; p80: number; p90: number }>;
}

export interface Outlook {
  as_of: string;              // the last day of weather
  residual: number;
  horizon: number;
  years: number;              // past seasons run
  fit: Fit | null;
  paddocks: PaddockOutlook[];
  property: {
    ae: number;
    feed_t: number;                       // feed above the residual today, tonnes
    /** Feed above the residual ahead, tonnes, with today's stock where they are now. */
    at: Record<"30" | "90" | "180", { low: number; median: number; high: number }>;
    capacity_ae: number;
  } | null;
}

export function residual(): number {
  const v = Number(getSetting("pasture_residual"));
  return Number.isFinite(v) && v > 0 ? v : 1000;
}

export function buildOutlook(): Outlook | null {
  const inp = loadInputs();
  if (!inp) return null;
  const fit = calibrate(inp);
  const params = fit?.params ?? DEFAULTS;
  const R = residual();
  const n = inp.end - inp.start + 1;

  // Soil water up to the last day of weather, for each grid point.
  const hist = new Map<string, Drive>();
  for (const [cell, w] of inp.weather) hist.set(cell, driver(w, 0, n, WMAX * 0.3));

  // The weather of every past year from tomorrow's date, from today's soil water.
  const lastYear = Number(isoOf(inp.end).slice(0, 4));
  const md = isoOf(inp.end + 1).slice(4).replace("-02-29", "-02-28");
  const firstYear = 1890;
  const longWeather = new Map<string, Weather>();
  for (const cell of inp.weather.keys()) longWeather.set(cell, loadWeather([cell], dayNo(`${firstYear}-01-01`), inp.end).get(cell)!);
  const years: number[] = [];
  for (let y = firstYear; y < lastYear; y++) if (dayNo(`${y}${md}`) + HORIZON <= inp.end) years.push(y);
  const scen = new Map<string, Drive[]>();
  for (const [cell, w] of longWeather) {
    const W0 = hist.get(cell)!.W;
    scen.set(cell, years.map((y) => driver(w, dayNo(`${y}${md}`) - w.start, HORIZON, W0)));
  }

  const out: PaddockOutlook[] = [];
  const cellGrowth = new Map<string, number>();
  let propAe = 0;
  const AHEAD = [30, 90, HORIZON] as const;
  // Feed above the residual on the whole place, season by season, at each of those days.
  const propAhead = years.map(() => AHEAD.map(() => 0));
  for (const p of inp.paddocks) {
    const last = p.obs[p.obs.length - 1] ?? null;
    const m = fit?.multipliers.get(p.id) ?? 1;
    const aeNow = p.ae[n - 1] ?? 0;
    propAe += aeNow * p.area;
    const o: PaddockOutlook = {
      id: p.id, name: p.name, subtype: p.subtype, area_ha: round(p.area, 1), multiplier: fit?.multipliers.has(p.id) ? m : null,
      last_reading: last ? { date: isoOf(last.day), tsdm: last.tsdm, green: last.green } : null,
      now: null, now_green: null, ae_per_ha: round(aeNow, 3), days_left: null, at: null, capacity_ae: null, series: [],
    };
    out.push(o);
    if (!last) continue;

    // From the latest reading up to yesterday, with what actually happened.
    const dr = hist.get(p.cell)!;
    const s0 = startState(last.tsdm, last.green);
    for (let t = last.day; t <= inp.end; t++) step(s0, params, m, dr.D[t - inp.start]!, dr.WI[t - inp.start]!, dr.R[t - inp.start]!, p.ae[t - inp.start]!);
    o.now = Math.round(s0[0]! + s0[1]!);
    o.now_green = Math.round(s0[0]!);

    const totals: Float64Array[] = [];
    for (const d of scen.get(p.cell)!) {
      const traj = new Float64Array(HORIZON + 1);
      const s = Float64Array.from(s0);
      traj[0] = s[0]! + s[1]!;
      for (let k = 0; k < HORIZON; k++) {
        step(s, params, m, d.D[k]!, d.WI[k]!, d.R[k]!, aeNow);
        traj[k + 1] = s[0]! + s[1]!;
      }
      totals.push(traj);
    }
    totals.forEach((t, yi) => AHEAD.forEach((k, j) => { propAhead[yi]![j]! += (Math.max(0, t[k]! - R) * p.area) / 1000; }));

    if (aeNow > 0) {
      const days = totals.map((t) => { for (let k = 0; k <= HORIZON; k++) if (t[k]! < R) return k; return Infinity; });
      const asDays = (v: number) => (Number.isFinite(v) ? v : null);
      // Outcomes, not seasons: "low" is the 20th percentile of past seasons, the earliest of the three.
      o.days_left = { low: asDays(pct(days, 0.2)), median: asDays(pct(days, 0.5)), high: asDays(pct(days, 0.8)) };
    }
    const at = (k: number) => {
      const xs = totals.map((t) => t[k]!);
      return { low: Math.round(pct(xs, 0.2)), median: Math.round(pct(xs, 0.5)), high: Math.round(pct(xs, 0.8)) };
    };
    o.at = { "30": at(30), "90": at(90), "180": at(HORIZON) };
    for (let k = 0; k <= HORIZON; k += STEP) {
      const xs = totals.map((t) => t[k]!);
      o.series.push({
        date: isoOf(inp.end + k),
        p10: Math.round(pct(xs, 0.1)), p20: Math.round(pct(xs, 0.2)), p50: Math.round(pct(xs, 0.5)),
        p80: Math.round(pct(xs, 0.8)), p90: Math.round(pct(xs, 0.9)),
      });
    }
    if (!cellGrowth.has(p.cell)) cellGrowth.set(p.cell, medianYearGrowth(longWeather.get(p.cell)!, params, lastYear));
    o.capacity_ae = round((cellGrowth.get(p.cell)! * m * UTILISATION * p.area) / (params.q * 365), 1);
  }

  // The whole place: feed above the residual now and ahead, with the stock
  // staying where they are (in practice they'd be moved on; it's the total
  // that matters here), and the long-term carrying capacity.
  const known = out.filter((o) => o.now !== null);
  let property: Outlook["property"] = null;
  if (known.length) {
    const spread = (j: number) => {
      const xs = propAhead.map((r) => r[j]!);
      return { low: Math.round(pct(xs, 0.2)), median: Math.round(pct(xs, 0.5)), high: Math.round(pct(xs, 0.8)) };
    };
    property = {
      ae: Math.round(propAe),
      feed_t: Math.round(known.reduce((t, o) => t + Math.max(0, o.now! - R) * o.area_ha, 0) / 1000),
      at: { "30": spread(0), "90": spread(1), "180": spread(2) },
      capacity_ae: Math.round(known.reduce((t, o) => t + (o.capacity_ae ?? 0), 0)),
    };
  }

  return { as_of: isoOf(inp.end), residual: R, horizon: HORIZON, years: years.length, fit, paddocks: out, property };
}

/**
 * Long-term carrying capacity rests on the median year's growth (July to June,
 * 1890 on) at a grid point, with the paddock held at a moderate cover. A
 * paddock's share is that × its multiplier; a quarter of it is eaten — the
 * share that holds land condition in this country — over what an AE eats in a year.
 */
function medianYearGrowth(w: Weather, p: Params, lastYear: number): number {
  const { D } = driver(w, 0, w.rain.length, WMAX * 0.3);
  const coverFactor = 1 - 1500 / BMAX;
  const totals: number[] = [];
  for (let y = 1890; y < lastYear; y++) {
    const a = dayNo(`${y}-07-01`) - w.start, b = dayNo(`${y + 1}-07-01`) - w.start;
    if (a < 0 || b > D.length) continue;
    let g = 0;
    for (let i = a; i < b; i++) g += p.g * D[i]! * coverFactor;
    totals.push(g);
  }
  return totals.length ? pct(totals, 0.5) : 0;
}

/** For checking the fit: errors of the predictions grouped by the month they start in. */
export function diagnose() {
  const inp = loadInputs();
  if (!inp) return null;
  const fit = calibrate(inp);
  if (!fit) return null;
  const drives = new Map<string, Drive>();
  for (const [cell, w] of inp.weather) drives.set(cell, driver(w, 0, inp.end - inp.start + 1, WMAX * 0.3));
  const rows = intervals(inp).map((iv) => {
    const s = predict(iv, drives, inp.start, fit.params, fit.multipliers.get(iv.p.id) ?? 1);
    const grazed = iv.p.ae.slice(iv.from - inp.start, iv.to - inp.start).reduce((t, v) => t + v, 0) / (iv.to - iv.from);
    return { month: isoOf(iv.from).slice(0, 7), model: s[0]! + s[1]! - iv.b.tsdm, persist: iv.a.tsdm - iv.b.tsdm, change: iv.b.tsdm - iv.a.tsdm,
      green_change: iv.b.green !== null && iv.a.green !== null ? iv.b.green - iv.a.green : null, grazed };
  });
  return { fit: { ...fit, multipliers: undefined }, rows };
}

/* ---------------------------- open-gate finder ---------------------------- */

export interface GateCandidate {
  gate_id: number;
  gate_name: string;
  stocked: number;      // paddock with stock recorded in it
  other: number;        // the paddock on the far side of the gate, with none recorded
  from: string;         // first day of the stretch
  to: string;           // the day the stocked paddock emptied (exclusive)
  confidence: "strong" | "likely";
  /** How much better "gate open" explains both paddocks' readings than "gate shut", %. */
  improvement: number;
  /** In the empty paddock over the stretch, kg/ha: what was measured, and what the model expects if rested and if shared. */
  other_change: { measured: number; if_rested: number; if_open: number };
  /** How the paddocks that really were rested over the same weeks did against the model, kg/ha: the season's own drift. */
  rested_drift: number;
  /** Feed gone from the empty side beyond resting, after allowing for the season's drift, kg/ha. */
  excess: number;
  /** Set when debugging: why a stretch wasn't suggested. */
  rejected?: string;
  ae: number;           // stock in the stocked paddock over the stretch, AE
}

/**
 * Gates that were probably open but never recorded as such — AgriWebb's
 * exports don't carry gates at all. For every stretch where a gate had stock
 * recorded on one side and none on the other, both explanations are run
 * through the fitted model from the readings at the start of the stretch:
 *
 *   shut  all the grazing falls on the stocked side; the other side rests
 *   open  the grazing is shared across both sides by area
 *
 * and compared with what PastureKey then measured on both sides. Where "open"
 * fits clearly better and the empty side lost feed it shouldn't have, the gate
 * is suggested. These are inferences: shown and recorded as such.
 */
export function findOpenGates(
  gates: Array<{ id: number; name: string; a: number; b: number }>,
  before: string,
  wasOpen: (gateId: number, date: string) => boolean,
  showRejected = false,
): GateCandidate[] {
  const loaded = loadInputs();
  if (!loaded) return [];
  const inp: Inputs = loaded;
  const fit = calibrate(inp);
  if (!fit) return [];
  const params = fit.params;
  const drives = new Map<string, Drive>();
  for (const [cell, w] of inp.weather) drives.set(cell, driver(w, 0, inp.end - inp.start + 1, WMAX * 0.3));
  const byId = new Map(inp.paddocks.map((p) => [p.id, p]));
  const limit = Math.min(inp.end + 1, dayNo(before));
  const MIN_DAYS = 10;
  const out: GateCandidate[] = [];


  /** Runs one paddock from a reading to the later readings, with the stock given over [s, e). */
  function run(p: Paddock, o: Obs, s: number, e: number, aeOn: (d: number) => number, upTo: Obs[]) {
    const dr = drives.get(p.cell)!, m = fit!.multipliers.get(p.id) ?? 1;
    const st = startState(o.tsdm, o.green);
    const at = new Map<number, number>();
    const lastDay = upTo[upTo.length - 1]!.day;
    for (let d = o.day; d < lastDay; d++) {
      step(st, params, m, dr.D[d - inp.start]!, dr.WI[d - inp.start]!, dr.R[d - inp.start]!, d >= s && d < e ? aeOn(d) : p.ae[d - inp.start]!);
      at.set(d + 1, st[0]! + st[1]!);
    }
    return upTo.map((x) => ({ x, pred: at.get(x.day) ?? o.tsdm }));
  }
  const startObs = (p: Paddock, s: number) => [...p.obs].reverse().find((o) => o.day <= s + 2 && o.day >= s - 10) ?? null;
  const later = (p: Paddock, from: number, e: number) => p.obs.filter((o) => o.day > from && o.day <= e + 3);

  /**
   * The season's own drift: over the same weeks, how far the paddocks that
   * really had no stock fell short of (or beat) what the model expected of
   * them resting. Autumn haying-off, say, takes feed off rested paddocks too,
   * and that mustn't read as grazing.
   */
  const driftCache = new Map<string, number>();
  function drift(s: number, e: number): number {
    const key = `${s}|${e}`;
    if (driftCache.has(key)) return driftCache.get(key)!;
    const shortfalls: number[] = [];
    for (const p of inp.paddocks) {
      let empty = true;
      for (let d = s; d < e && empty; d++) if (p.ae[d - inp.start]! > 0) empty = false;
      if (!empty) continue;
      const o = startObs(p, s);
      const l = o ? later(p, o.day, e) : [];
      if (!o || !l.length) continue;
      const r = run(p, o, s, e, () => 0, l);
      const last = r[r.length - 1]!;
      shortfalls.push(last.pred - last.x.tsdm);
    }
    const v = shortfalls.length >= 3 ? pct(shortfalls, 0.5) : 0;
    driftCache.set(key, v);
    return v;
  }

  function test(pa: Paddock, pb: Paddock, s: number, e: number): Omit<GateCandidate, "gate_id" | "gate_name" | "stocked" | "other" | "from" | "to"> {
    const oa = startObs(pa, s), ob = startObs(pb, s);
    const none = (why: string) => ({
      confidence: "likely" as const, improvement: 0, other_change: { measured: 0, if_rested: 0, if_open: 0 },
      rested_drift: 0, excess: 0, ae: 0, rejected: why,
    });
    if (!oa || !ob) return none("no reading near the start");
    const la = later(pa, oa.day, e), lb = later(pb, ob.day, e);
    if (lb.length < 2 || !la.length) return none("too few readings during the stretch");
    const totalAe = (d: number) => pa.ae[d - inp.start]! * pa.area;
    const shared = (d: number) => totalAe(d) / (pa.area + pb.area);

    const sse = (rows: Array<{ x: Obs; pred: number }>) => rows.reduce((t, r) => t + r.x.w * (r.pred - r.x.tsdm) ** 2, 0);
    const shutA = run(pa, oa, s, e, (d) => pa.ae[d - inp.start]!, la), shutB = run(pb, ob, s, e, () => 0, lb);
    const openA = run(pa, oa, s, e, shared, la), openB = run(pb, ob, s, e, shared, lb);
    const sse0 = sse(shutA) + sse(shutB), sse1 = sse(openA) + sse(openB);
    const improvement = sse0 > 0 ? (sse0 - sse1) / sse0 : 0;
    const stockedSideAgrees = sse(openA) <= sse(shutA);

    const last = lb[lb.length - 1]!;
    const measured = last.tsdm - ob.tsdm;
    const ifRested = shutB[shutB.length - 1]!.pred - ob.tsdm;
    const ifOpen = openB[openB.length - 1]!.pred - ob.tsdm;
    const restedDrift = drift(s, e);
    // Gone from the empty side beyond what resting explains, beyond the season's drift.
    const excess = ifRested - measured - restedDrift;
    // What sharing the stock would have taken from it.
    const expected = ifRested - ifOpen;

    let aeSum = 0;
    for (let d = s; d < e; d++) aeSum += totalAe(d);
    const base = {
      improvement: Math.round(improvement * 100),
      other_change: { measured: Math.round(measured), if_rested: Math.round(ifRested), if_open: Math.round(ifOpen) },
      rested_drift: Math.round(restedDrift), excess: Math.round(excess), ae: Math.round(aeSum / (e - s)),
    };
    let confidence: "strong" | "likely" | null = null;
    if (stockedSideAgrees && improvement > 0.5 && excess > 150 && excess > 0.5 * expected) confidence = "strong";
    else if (stockedSideAgrees && improvement > 0.25 && excess > 80 && excess > 0.3 * expected) confidence = "likely";
    if (!confidence) {
      const why = !stockedSideAgrees ? "the stocked side fits better with the gate shut"
        : excess <= 80 ? "the empty side lost no more than the rested paddocks did"
        : "the readings don't favour the gate being open enough";
      return { ...base, confidence: "likely" as const, rejected: why };
    }
    return { ...base, confidence };
  }

  for (const g of gates) {
    for (const [A, B] of [[g.a, g.b], [g.b, g.a]] as const) {
      const pa = byId.get(A), pb = byId.get(B);
      if (!pa || !pb || pa.obs.length < 3 || pb.obs.length < 3) continue;
      // Stretches with stock in A and none in B.
      let t = Math.max(inp.start, Math.min(pa.obs[0]!.day, pb.obs[0]!.day));
      while (t < limit) {
        const i = t - inp.start;
        if (!(pa.ae[i]! > 0 && pb.ae[i]! === 0)) { t++; continue; }
        let e = t;
        while (e < limit && pa.ae[e - inp.start]! > 0 && pb.ae[e - inp.start]! === 0) e++;
        const s0 = t;
        t = e;
        if (e - s0 < MIN_DAYS || wasOpen(g.id, isoOf(s0 + Math.floor((e - s0) / 2)))) continue;
        const c = test(pa, pb, s0, e);
        if (c && (!c.rejected || showRejected)) out.push({ gate_id: g.id, gate_name: g.name, stocked: A, other: B, from: isoOf(s0), to: isoOf(e), ...c });
      }
    }
  }
  return out.sort((x, y) => (x.from < y.from ? -1 : 1));
}
