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
import { mobViews, paddockHistories, today } from "../stock/store.js";
import { StockError } from "../stock/actions.js";
import type { PlanGroup, PlanProjection } from "./model.js";
import { restWeights } from "./capacity.js";

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
const confidenceFor = (ageDays: number | null) =>
  ageDays === null ? SCORE.staleTo : ageDays <= SCORE.freshDays ? 1 : Math.max(SCORE.staleTo, 1 - (ageDays - SCORE.freshDays) / (SCORE.staleOver - SCORE.freshDays) * (1 - SCORE.staleTo));

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
    if (cur?.now !== null && cur?.now !== undefined && cur.now < rules.residual) notes.push(`already below ${rules.residual} kg/ha`);
    if (daysIn + moveIn < rules.min_days) notes.push(`under the ${rules.min_days}-day minimum stay`);
    if (!left) notes.push("no pasture readings for where it is");

    const options = (proj.options[key] ?? [])
      .filter((o) => !occupied.has(o.paddock_id) && !skip.has(o.paddock_id) && o.days.median >= rules.min_days)
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
        const parts = {
          feed: r1(raw.feed * confidence), margin: r1(raw.margin * confidence), green: r1(raw.green * confidence),
          rest: r1(Math.min(restCounts ?? SCORE.restUnknown, SCORE.restCap) / 10),
          walk: gatesAway === null ? 0 : SCORE.walk[gatesAway] ?? 0,
        };
        const score = parts.feed + parts.margin + parts.green + parts.rest + parts.walk;
        return {
          paddock_id: o.paddock_id, name: p.name, area_ha: p.area_ha, now: o.now, reading: p.last_reading,
          stay, days: o.days, rest_days: rest, rest_counts: restCounts, rest_weight: weight, adjacent, score: Math.round(score * 10) / 10,
          parts, rest_known: rest !== null, gates_away: gatesAway, green_share: greenShare === null ? null : r1(greenShare * 100),
          confidence: Math.round(confidence * 100), reading_age: age,
          facts: {
            reading: p.reading, now_green: p.now_green, multiplier: p.multiplier, rain_since_reading: p.rain_since_reading,
            rain_30: p.rain_30, rain_30_median: p.rain_30_median, soil_water_pct: p.soil_water_pct, rain_ahead: p.rain_ahead,
          },
        };
      })
      .sort((a, b) => b.score - a.score);

    const owners = [...new Set(g.views.map((v) => v.mob.owner).filter(Boolean))];
    return {
      key, mob_ids: g.views.map((v) => v.mob.id),
      mob: g.views.map((v) => v.mob.name).join(" + "), mobs: g.views.length, owner: owners.join(", ") || null,
      head: g.views.reduce((t, v) => t + v.state.head, 0), ae: Math.round(g.views.reduce((t, v) => t + aeOf(v), 0)),
      paddocks: g.paddocks.map((id) => pad.get(id)?.name ?? `#${id}`), paddock_ids: g.paddocks,
      in_since: since, days_in: daysIn,
      now: cur?.now ?? null, days_left: left,
      move_by: addDays(now, moveIn), move_in: moveIn, why, notes,
      suggested: null as null | (typeof options)[number], options: options.slice(0, 6),
    };
  }).sort((a, b) => a.move_in - b.move_in);

  // Most urgent first: each takes its best paddock no one ahead of it has taken.
  const taken = new Set<number>();
  for (const m of mobs) {
    const pick = m.options.find((o) => !taken.has(o.paddock_id)) ?? null;
    m.suggested = pick;
    if (pick) taken.add(pick.paddock_id);
  }
  return { as_of: proj.as_of, rules, mobs, unplanned };
}
