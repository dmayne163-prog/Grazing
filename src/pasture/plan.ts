/**
 * The rotation planner, step one: for each mob, how long it can stay where it
 * is, when it should move, and the best paddocks to move it to next.
 *
 * David's rules (24 Oct 2026): leave at least the target residual (1,200
 * kg/ha); no mob more than 42 days in one place; ideally at least 7 days in
 * each paddock, or the work of moving gets too much; water isn't a factor.
 * Mobs move more often in the growing season because the paddocks run down
 * and recover faster then, which the pasture model's growth carries.
 *
 * The days of grazing come from the pasture model (in its worker thread),
 * across past seasons from today's soil water: the median, and a drier run
 * (the 20th percentile). Suggestions only; nothing is moved.
 */
import { getSetting, setSetting } from "../db/database.js";
import { listGates } from "../map/gates.js";
import { mobLeaving, mobRotation, mobViews, paddockHistories, today } from "../stock/store.js";
import { listFeatures } from "../map/store.js";
import { StockError } from "../stock/actions.js";
import type { PlanGroup, PlanProjection } from "./model.js";
import { restWeights } from "./capacity.js";
import { DEFAULT_READY_DAYS, latestPlantings } from "./plantings.js";

export interface PlanRules { residual: number; min_days: number; max_days: number }

export function planRules(): PlanRules {
  const s = getSetting("plan_rules");
  const r = s ? (JSON.parse(s) as Partial<PlanRules>) : {};
  return { residual: r.residual ?? 1200, min_days: r.min_days ?? 7, max_days: r.max_days ?? 42 };
}

export function setPlanRules(input: Partial<Record<keyof PlanRules, unknown>>): PlanRules {
  const cur = planRules();
  const num = (v: unknown, lo: number, hi: number, name: string) => {
    if (v === undefined) return undefined;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new StockError(`${name} must be between ${lo} and ${hi}`);
    return n;
  };
  const next: PlanRules = {
    residual: num(input.residual, 200, 5000, "The residual") ?? cur.residual,
    min_days: num(input.min_days, 1, 60, "The shortest stay") ?? cur.min_days,
    max_days: num(input.max_days, 7, 180, "The longest stay") ?? cur.max_days,
  };
  if (next.min_days > next.max_days) throw new StockError("The shortest stay can't be longer than the longest");
  setSetting("plan_rules", JSON.stringify(next));
  return next;
}

/**
 * Areas that aren't paddocks to rotate through: a "management only" area (like
 * "lost boys and girls", where AgriWebb kept cattle whose paddock wasn't
 * known), and holding areas (yards). Never offered, and stock in one aren't
 * planned until they're put in a real paddock.
 */
const notForGrazing = (subtype: string | null) => /management|holding/i.test(subtype ?? "");

/** How far ahead feed is projected, days: past the longest stay, so a margin of spare feed counts. */
export const FEED_HORIZON = 120;

/**
 * How the options are scored (David, 23 Nov 2026). Points are roughly days.
 *  - Feed: days it lasts, up to the longest stay, half from a typical season
 *    and half from a drier one, so a paddock that only lasts if it rains loses.
 *  - Margin: feed past the longest stay counts a quarter, up to FEED_HORIZON.
 *  - Green: up to 15 for the share of the feed that's green (quality).
 *  - Rest: a tenth of the days rested (poorer country counts less), up to 12.
 *  - Walk: 5 through one gate, 3 through two, 1.5 through three.
 * Feed, margin and green all lean on the pasture model, so when the latest
 * Cibo reading is more than three weeks old they count for less (down to
 * half at four months), leaving rest and the walk to count for more.
 */
const SCORE = { marginShare: 0.25, greenMax: 15, restCap: 120, restUnknown: 60, walk: [0, 5, 3, 1.5] as const, freshDays: 21, staleTo: 0.5, staleOver: 120 };
/**
 * The last paddock before a mob leaves (a booked sale): it only needs feed
 * until the day, spare feed is no use, and being close to the yards counts
 * most. Feed: up to 20 for lasting until the day in a drier season. Yards:
 * 20 next to the yards, 12 two gates away, 6 three.
 */
const LEAVING = { feedMax: 20, yards: [20, 20, 12, 6] as const };

const confidenceFor = (ageDays: number | null) =>
  ageDays === null ? SCORE.staleTo : ageDays <= SCORE.freshDays ? 1 : Math.max(SCORE.staleTo, 1 - (ageDays - SCORE.freshDays) / (SCORE.staleOver - SCORE.freshDays) * (1 - SCORE.staleTo));

/** Every ring's points of a polygon or multipolygon, as [lon, lat]. */
function rings(geometry: string): number[][][] {
  const g = JSON.parse(geometry) as { type: string; coordinates: unknown };
  if (g.type === "Polygon") return g.coordinates as number[][][];
  if (g.type === "MultiPolygon") return (g.coordinates as number[][][][]).flat();
  return [];
}

/**
 * The shortest distance between two paddocks' fences, metres (0 if they
 * touch or overlap at a corner). Flat-earth over a few km is plenty here.
 */
function fenceGap(a: number[][][], b: number[][][]): number {
  const lat0 = (a[0]?.[0]?.[1] ?? 0) * Math.PI / 180;
  const kx = 111_320 * Math.cos(lat0), ky = 110_540;
  const xy = (p: number[]) => [p[0]! * kx, p[1]! * ky] as const;
  const segDist = (p: readonly [number, number], s: readonly [number, number], e: readonly [number, number]) => {
    const dx = e[0] - s[0], dy = e[1] - s[1];
    const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy));
  };
  let best = Infinity;
  const one = (from: number[][][], to: number[][][]) => {
    for (const r of from) for (const p of r) {
      const q = xy(p);
      for (const ring of to) for (let i = 1; i < ring.length; i++) {
        best = Math.min(best, segDist(q, xy(ring[i - 1]!), xy(ring[i]!)));
        if (best === 0) return;
      }
    }
  };
  one(a, b); one(b, a);
  return best;
}

/** A paddock whose fence comes within this of the yards counts as next to them. */
const NEXT_TO_YARDS_M = 150;

/** Gates crossed from one set of paddocks to another, through gates between two paddocks (null if more than 3). */
function gateHops(gates: Array<{ paddocks: number[] }>) {
  const next = new Map<number, Set<number>>();
  for (const g of gates) {
    const [a, b] = g.paddocks as [number, number];
    if (!next.has(a)) next.set(a, new Set());
    if (!next.has(b)) next.set(b, new Set());
    next.get(a)!.add(b); next.get(b)!.add(a);
  }
  return (from: number[], to: number): number | null => {
    let frontier = new Set(from);
    const seen = new Set(from);
    for (let hop = 1; hop <= 3; hop++) {
      const n = new Set<number>();
      for (const p of frontier) for (const q of next.get(p) ?? []) if (!seen.has(q)) { seen.add(q); n.add(q); }
      if (n.has(to)) return hop;
      frontier = n;
    }
    return null;
  };
}

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const niceDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

type View = ReturnType<typeof mobViews>[number];
const aeOf = (v: View) => v.ae_total ?? v.state.head;

/**
 * Mobs running together (in exactly the same paddocks) are planned as one
 * group that moves together: the five lots of young cattle in Tablelands,
 * the three in Western Stud.
 */
function together(): Array<{ key: string; views: View[]; paddocks: number[] }> {
  const views = mobViews().filter((v) => v.state.head > 0 && v.state.paddock_ids.length);
  const groups = new Map<string, { key: string; views: View[]; paddocks: number[] }>();
  for (const v of views) {
    const ids = [...v.state.paddock_ids].sort((a, b) => a - b);
    const key = ids.join("+");
    const g = groups.get(key) ?? { key, views: [], paddocks: ids };
    g.views.push(v);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The groups as the planner sees them, ready for the model worker. */
export function planGroups(): PlanGroup[] {
  const all = together();
  return all.map((g) => {
    const here = new Set(g.paddocks);
    const aeHere = all.filter((o) => o.paddocks.some((p) => here.has(p))).flatMap((o) => o.views).reduce((t, v) => t + aeOf(v), 0);
    return { key: g.key, ae: g.views.reduce((t, v) => t + aeOf(v), 0), ae_here: aeHere, paddocks: g.paddocks };
  });
}

/** Ranks the options and turns the projection into a plan. */
export function makePlan(proj: PlanProjection, rules: PlanRules) {
  const now = today();
  const pad = new Map(proj.paddocks.map((p) => [p.id, p]));
  const skip = new Set(proj.paddocks.filter((p) => notForGrazing(p.subtype)).map((p) => p.id));
  const all = together();
  const groups = all.filter((g) => g.paddocks.some((id) => !skip.has(id)));
  const unplanned = all.filter((g) => !g.paddocks.some((id) => !skip.has(id))).map((g) => ({
    mob: g.views.map((v) => v.mob.name).join(" + "), head: g.views.reduce((t, v) => t + v.state.head, 0),
    where: g.paddocks.map((id) => pad.get(id)?.name ?? `#${id}`).join(" + "),
  }));
  const occupied = new Set(groups.flatMap((g) => g.paddocks));
  const hist = paddockHistories();
  const gates = listGates().filter((g) => g.paddocks.length === 2);
  // A rest on poorer country counts for less: its pasture grows back more slowly.
  const { weights } = restWeights();
  const hops = gateHops(gates);
  // The yards cattle leave from: a mob can name its own, or the holding paddock called Yards.
  const paddockRows = listFeatures().filter((f) => f.kind === "paddock");
  const nameOf = (id: number) => pad.get(id)?.name ?? paddockRows.find((f) => f.id === id)?.name ?? `#${id}`;
  const defaultYards = (paddockRows.find((f) => /holding/i.test(f.subtype ?? "") && /yard/i.test(f.name ?? ""))
    ?? paddockRows.find((f) => /holding/i.test(f.subtype ?? "")))?.id ?? null;
  /**
   * How close a paddock is to the yards: 1 if its fence is within 150 m of
   * them (or a gate joins them), otherwise 1 + the gates to the nearest such
   * paddock; null past 3. Yards are often reached along lanes rather than
   * through a mapped gate, so nearness counts as well as gates.
   */
  const yardsCache = new Map<number, { near: Set<number>; gap: Map<number, number> }>();
  const yardsInfo = (yardsId: number) => {
    let c = yardsCache.get(yardsId);
    if (!c) {
      const y = paddockRows.find((f) => f.id === yardsId);
      const yr = y ? rings(y.geometry) : [];
      const gap = new Map<number, number>();
      for (const f of paddockRows) if (f.id !== yardsId && yr.length) gap.set(f.id, fenceGap(yr, rings(f.geometry)));
      const near = new Set([...gap].filter(([, d]) => d <= NEXT_TO_YARDS_M).map(([id]) => id));
      for (const gt of gates) if (gt.paddocks.includes(yardsId)) gt.paddocks.forEach((id) => id !== yardsId && near.add(id));
      c = { near, gap };
      yardsCache.set(yardsId, c);
    }
    return c;
  };
  // David's own say on each paddock beats the map: "easy" (a laneway or
  // short muster to the yards) or "hard" (timbered, a long muster).
  const access = new Map<number, string>();
  for (const f of paddockRows) {
    const a = (JSON.parse(f.props || "{}") as Record<string, unknown>)["yards_access"];
    if (a === "easy" || a === "hard") access.set(f.id, a);
  }
  const accessOf = (from: number[]) => from.some((id) => access.get(id) === "easy") ? "easy"
    : from.every((id) => access.get(id) === "hard") ? "hard" : null;
  const yardsHopsOf = (from: number[], yardsId: number): number | null => {
    if (from.includes(yardsId)) return 0;
    const a = accessOf(from);
    if (a === "easy") return 1;
    if (a === "hard") return null;
    const { near } = yardsInfo(yardsId);
    if (from.includes(yardsId) || from.some((id) => near.has(id))) return from.includes(yardsId) ? 0 : 1;
    let best: number | null = null;
    for (const n of near) { const h = hops(from, n); if (h !== null && h < 3 && (best === null || h + 1 < best)) best = h + 1; }
    return best;
  };
  // A crop not ready to graze yet is left out until it is. With no ready date
  // given, it's taken as about 8 weeks after planting.
  const plantings = latestPlantings();
  const readyOn = (id: number) => {
    const p = plantings.get(id);
    return p ? p.ready_on ?? addDays(p.sown_on, DEFAULT_READY_DAYS) : null;
  };
  const plantingOf = (id: number) => {
    const p = plantings.get(id);
    return p ? { crop: p.crop, crops: p.crops, sown_on: p.sown_on, rate_kg_ha: p.rate_kg_ha, fertiliser: p.fertiliser, ready_on: readyOn(id)!, ready_guessed: !p.ready_on } : null;
  };
  const notReady = [...plantings.keys()]
    .filter((id) => readyOn(id)! > now && !skip.has(id))
    .map((id) => ({ paddock_id: id, name: nameOf(id), ...plantingOf(id)! }))
    .sort((a, b) => a.ready_on.localeCompare(b.ready_on));
  const yardsKm = (id: number, yardsId: number) => { const d = yardsInfo(yardsId).gap.get(id); return d === undefined ? null : Math.round(d / 100) / 10; };

  const mobs = groups.map((g) => {
    const key = g.key;
    const cur = proj.current[key];
    // In since the first of them arrived: the paddocks have been grazed since then.
    const since = g.views.map((v) => v.state.in_paddock_since ?? now).sort()[0]!;
    const daysIn = Math.max(0, daysBetween(since, now));
    const left = cur?.days ?? null;
    // Time's up at the longest stay, or when the feed runs down, whichever first.
    const byLimit = Math.max(0, rules.max_days - daysIn);
    const byFeed = left ? left.median : null;
    const moveIn = byFeed === null ? byLimit : Math.min(byLimit, byFeed);
    const why = byFeed !== null && byFeed <= byLimit ? "feed" : "limit";
    const notes: string[] = [];
    if (left && left.median < rules.max_days && left.low < left.median - 3) notes.push(`a drier run would leave ${left.low} days`);
    // The floor where it is: each paddock's own, area-weighted, or the farm's.
    const here = g.paddocks.map((id) => pad.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    const hereArea = here.reduce((t, p) => t + p.area_ha, 0);
    const floor = hereArea ? Math.round(here.reduce((t, p) => t + (p.floor ?? rules.residual) * p.area_ha, 0) / hereArea) : rules.residual;
    if (cur?.now !== null && cur?.now !== undefined && cur.now < floor) notes.push(`already below ${floor} kg/ha`);
    if (daysIn + moveIn < rules.min_days) notes.push(`under the ${rules.min_days}-day minimum stay`);
    if (!left) notes.push("no pasture readings for where it is");

    // Booked to leave: plan only up to the day, and end up near the yards.
    const bookings = g.views.map((v) => ({ name: v.mob.name, l: mobLeaving(v.mob) }));
    const booked = bookings.filter((b) => b.l);
    let leaving: null | { date: string; days: number; note: string | null; yards_id: number | null; yards: string | null; yards_hops_now: number | null; stays: boolean; need: number; last: boolean; head_leaving: number; head_staying: number } = null;
    if (booked.length && booked.length === bookings.length) {
      const date = booked.map((b) => b.l!.date).sort().at(-1)!;
      const days = daysBetween(now, date);
      if (days < 0) notes.push(`was booked to leave on ${niceDay(date)}: record the sale, or change the date`);
      else {
        const yardsId = booked.find((b) => b.l!.yards_id !== null)?.l!.yards_id ?? defaultYards;
        const hopsNow = yardsId === null ? null : yardsHopsOf(g.paddocks, yardsId);
        // Already next to the yards with feed to the day: stay, even past the
        // longest stay, rather than move once more just before they leave.
        const stays = moveIn >= days || (byFeed !== null && byFeed >= days && hopsNow !== null && hopsNow <= 1);
        if (stays && daysIn + days > rules.max_days) notes.push(`stays ${daysIn + days - rules.max_days} days past the ${rules.max_days}-day limit: it's next to the yards with feed until it leaves, so that saves a move`);
        leaving = {
          date, days, note: booked.map((b) => b.l!.note).find(Boolean) ?? null, yards_id: yardsId, yards: yardsId === null ? null : nameOf(yardsId),
          yards_hops_now: hopsNow, stays, need: stays ? 0 : days - moveIn, last: stays || days - moveIn <= rules.max_days,
          // Part of a mob can be booked: the whole mob is mustered and drafted
          // on the day, so it still wants to be near the yards; the rest are
          // planned again once the sale is recorded.
          head_leaving: 0, head_staying: 0,
        };
        for (const v of g.views) {
          const l = mobLeaving(v.mob)!;
          const go = l.head === null ? v.state.head : Math.min(l.head, v.state.head);
          leaving.head_leaving += go;
          leaving.head_staying += v.state.head - go;
        }
        if (leaving.head_staying > 0) notes.push(`${leaving.head_staying} hd stay on after ${niceDay(date)}: they'll be planned again once the sale is recorded`);
      }
    } else if (booked.length) {
      for (const b of booked) notes.push(`${b.name} is booked to leave on ${niceDay(b.l!.date)}`);
    }

    // The paddocks it rotates around, if set: suggestions come from those.
    const rotIds = [...new Set(g.views.flatMap((v) => mobRotation(v.mob)?.paddock_ids ?? []))];
    const rotSet = new Set(rotIds);
    // The day it would go in: a crop ready by then can be suggested.
    const goesIn = addDays(now, moveIn);
    const options = (proj.options[key] ?? [])
      .filter((o) => !occupied.has(o.paddock_id) && !skip.has(o.paddock_id) && (readyOn(o.paddock_id) ?? "") <= goesIn && (leaving?.last ? o.days.median >= Math.max(1, leaving.need) : o.days.median >= rules.min_days))
      .map((o) => {
        const h = hist.get(o.paddock_id);
        const rest = h ? (h.occupied ? 0 : h.rest_days) : null;
        const gatesAway = hops(g.paddocks, o.paddock_id);
        const adjacent = gatesAway === 1;
        const stay = Math.min(o.days.median, rules.max_days);
        const weight = weights.get(o.paddock_id) ?? 1;
        const restCounts = rest === null ? null : Math.round(rest * weight);
        const p = pad.get(o.paddock_id)!;
        const age = p.reading ? daysBetween(p.reading.date, now) : null;
        const confidence = confidenceFor(age);
        const r1 = (x: number) => Math.round(x * 10) / 10;
        const greenShare = p.now_green !== null && o.now > 0 ? Math.min(1, p.now_green / o.now) : null;
        const raw = {
          feed: (Math.min(o.days.median, rules.max_days) + Math.min(o.days.low, rules.max_days)) / 2,
          margin: Math.max(0, Math.min(o.days.median, FEED_HORIZON) - rules.max_days) * SCORE.marginShare,
          green: (greenShare ?? 0) * SCORE.greenMax,
        };
        const yardsHops = !leaving?.last || leaving.yards_id == null ? null : yardsHopsOf([o.paddock_id], leaving.yards_id);
        const yardsFar = !leaving?.last || leaving.yards_id == null ? null : yardsKm(o.paddock_id, leaving.yards_id);
        const parts = leaving?.last ? {
          // Leaving: only enough feed to get to the day matters, then the yards.
          feed: r1(Math.min(1, o.days.low / Math.max(1, leaving.need)) * LEAVING.feedMax * confidence), margin: 0,
          green: r1(raw.green * confidence),
          rest: r1(Math.min(restCounts ?? SCORE.restUnknown, SCORE.restCap) / 10),
          walk: gatesAway === null ? 0 : SCORE.walk[gatesAway] ?? 0,
          yards: yardsHops === null ? 0 : LEAVING.yards[yardsHops] ?? 0,
        } : {
          feed: r1(raw.feed * confidence), margin: r1(raw.margin * confidence), green: r1(raw.green * confidence),
          rest: r1(Math.min(restCounts ?? SCORE.restUnknown, SCORE.restCap) / 10),
          walk: gatesAway === null ? 0 : SCORE.walk[gatesAway] ?? 0,
          yards: 0,
        };
        const score = parts.feed + parts.margin + parts.green + parts.rest + parts.walk + parts.yards;
        return {
          paddock_id: o.paddock_id, name: p.name, area_ha: p.area_ha, now: o.now, reading: p.last_reading, floor: p.floor ?? rules.residual,
          stay, days: o.days, rest_days: rest, rest_counts: restCounts, rest_weight: weight, adjacent, score: Math.round(score * 10) / 10,
          parts, rest_known: rest !== null, gates_away: gatesAway, green_share: greenShare === null ? null : r1(greenShare * 100),
          confidence: Math.round(confidence * 100), reading_age: age, yards_hops: yardsHops, yards_km: yardsFar, yards_access: access.get(o.paddock_id) ?? null,
          planting: plantingOf(o.paddock_id),
          facts: {
            reading: p.reading, now_green: p.now_green, multiplier: p.multiplier, rain_since_reading: p.rain_since_reading,
            rain_30: p.rain_30, rain_30_median: p.rain_30_median, soil_water_pct: p.soil_water_pct, rain_ahead: p.rain_ahead,
          },
        };
      })
      .sort((a, b) => b.score - a.score);
    // Kept to its rotation, unless it's leaving (the last paddock is about the
    // yards) or none of its paddocks will do: then the best of the rest, flagged.
    let rotOutside = false;
    let chosen = options;
    if (rotSet.size && !leaving?.last) {
      const inGroup = options.filter((o) => rotSet.has(o.paddock_id));
      if (inGroup.length) chosen = inGroup;
      else { rotOutside = true; notes.push("none of its rotation paddocks is free with enough feed, so these are from outside it"); }
    }
    const rotation = rotSet.size ? { paddock_ids: rotIds, names: rotIds.map(nameOf), outside: rotOutside } : null;

    const owners = [...new Set(g.views.map((v) => v.mob.owner).filter(Boolean))];
    return {
      key, mob_ids: g.views.map((v) => v.mob.id),
      mob: g.views.map((v) => v.mob.name).join(" + "), mobs: g.views.length, owner: owners.join(", ") || null,
      head: g.views.reduce((t, v) => t + v.state.head, 0), ae: Math.round(g.views.reduce((t, v) => t + aeOf(v), 0)),
      paddocks: g.paddocks.map((id) => pad.get(id)?.name ?? `#${id}`), paddock_ids: g.paddocks,
      in_since: since, days_in: daysIn, floor,
      now: cur?.now ?? null, days_left: left,
      move_by: addDays(now, leaving?.stays ? leaving.days : moveIn), move_in: leaving?.stays ? leaving.days : moveIn, why, notes, leaving,
      suggested: null as null | (typeof options)[number], options: leaving?.stays ? [] : chosen.slice(0, 6),
      rotation, all_options: proj.options[key] ?? [], leave_on: leaving?.date ?? null,
      pattern: [] as Array<{ paddock_id: number; name: string; from: string; to: string }>,
      /** Set when its rotation runs out of paddocks with enough feed: the day it would need one. */
      short_from: null as string | null,
    };
  }).sort((a, b) => a.move_in - b.move_in);

  // Most urgent first: each takes its best paddock no one ahead of it has taken.
  const taken = new Set<number>();
  for (const m of mobs) {
    const pick = m.options.find((o) => !taken.has(o.paddock_id)) ?? null;
    m.suggested = pick;
    if (pick) taken.add(pick.paddock_id);
  }
  // The next few moves for each mob, roughly: so the map can show where each
  // is heading and in what order. Each stop lasts as long as its feed (as
  // projected today) up to the longest stay; a paddock is only used by one mob
  // at a time; rest counts from now to the day it would go in.
  const busy = new Map<number, Array<[string, string]>>();
  const book = (id: number, a: string, b: string) => { const l = busy.get(id) ?? []; l.push([a, b]); busy.set(id, l); };
  const free = (id: number, a: string, b: string) => !(busy.get(id) ?? []).some(([x, y]) => a < y && x < b);
  for (const m of mobs) for (const id of m.paddock_ids) book(id, now, m.move_by);
  const stayOf = (d: { median: number }) => Math.max(rules.min_days, Math.min(d.median, rules.max_days));
  for (const m of mobs) {
    const o = m.suggested;
    if (!o) continue;
    const to = addDays(m.move_by, stayOf(o.days));
    m.pattern.push({ paddock_id: o.paddock_id, name: o.name, from: m.move_by, to });
    book(o.paddock_id, m.move_by, to);
  }
  const horizon = addDays(now, FEED_HORIZON);
  for (let round = 0; round < 3; round++) {
    const order = mobs.filter((m) => m.pattern.length === round + 1 && !m.leaving?.last)
      .sort((a, b) => a.pattern.at(-1)!.to.localeCompare(b.pattern.at(-1)!.to));
    for (const m of order) {
      const last = m.pattern.at(-1)!;
      const start = last.to;
      if (start > horizon || (m.leave_on && start >= m.leave_on)) continue;
      const rot = new Set(m.rotation?.paddock_ids ?? []);
      const used = new Set([...m.paddock_ids, ...m.pattern.map((s) => s.paddock_id)]);
      const pick = (allowUsed: boolean) => m.all_options
        .filter((c) => !skip.has(c.paddock_id) && (!rot.size || rot.has(c.paddock_id)) && (allowUsed || !used.has(c.paddock_id))
          && c.paddock_id !== last.paddock_id && (readyOn(c.paddock_id) ?? "") <= start && c.days.median >= rules.min_days
          && free(c.paddock_id, start, addDays(start, stayOf(c.days))))
        .map((c) => {
          const h = hist.get(c.paddock_id);
          // A paddock used earlier in this pattern has only rested since it was left.
          const leftAt = m.pattern.filter((s) => s.paddock_id === c.paddock_id).at(-1)?.to;
          const rested = leftAt ? daysBetween(leftAt, start) : (h ? (h.occupied ? 0 : h.rest_days ?? SCORE.restUnknown) : SCORE.restUnknown) + daysBetween(now, start);
          const gates = hops([last.paddock_id], c.paddock_id);
          const score = (Math.min(c.days.median, rules.max_days) + Math.min(c.days.low, rules.max_days)) / 2
            + Math.min(rested, SCORE.restCap) / 10 + (gates === null ? 0 : SCORE.walk[gates] ?? 0);
          return { c, score };
        })
        .sort((a, b) => b.score - a.score)[0];
      const best = pick(false) ?? (rot.size ? pick(true) : undefined);
      if (!best) { if (rot.size) m.short_from = start; continue; }
      const to = addDays(start, stayOf(best.c.days));
      m.pattern.push({ paddock_id: best.c.paddock_id, name: nameOf(best.c.paddock_id), from: start, to });
      book(best.c.paddock_id, start, to);
    }
  }
  for (const m of mobs) (m as { all_options?: unknown }).all_options = undefined;

  return { as_of: proj.as_of, rules, mobs, unplanned, not_ready: notReady };
}
