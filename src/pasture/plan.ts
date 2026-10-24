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
  const groups = together();
  const pad = new Map(proj.paddocks.map((p) => [p.id, p]));
  const occupied = new Set(groups.flatMap((g) => g.paddocks));
  const hist = paddockHistories();
  const gates = listGates().filter((g) => g.paddocks.length === 2);
  const nextDoor = (a: number, b: number) => gates.some((g) => g.paddocks.includes(a) && g.paddocks.includes(b));

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
      .filter((o) => !occupied.has(o.paddock_id) && o.days.median >= rules.min_days)
      .map((o) => {
        const h = hist.get(o.paddock_id);
        const rest = h ? (h.occupied ? 0 : h.rest_days) : null;
        const adjacent = g.paddocks.some((p) => nextDoor(p, o.paddock_id));
        const stay = Math.min(o.days.median, rules.max_days);
        // Feed for a full stay counts most, then a long rest, then being next door (less walking).
        const score = stay + Math.min(rest ?? 60, 120) / 10 + (adjacent ? 5 : 0);
        const p = pad.get(o.paddock_id)!;
        return {
          paddock_id: o.paddock_id, name: p.name, area_ha: p.area_ha, now: o.now, reading: p.last_reading,
          stay, days: o.days, rest_days: rest, adjacent, score: Math.round(score * 10) / 10,
        };
      })
      .sort((a, b) => b.score - a.score);

    const owners = [...new Set(g.views.map((v) => v.mob.owner).filter(Boolean))];
    return {
      key, mob_ids: g.views.map((v) => v.mob.id),
      mob: g.views.map((v) => v.mob.name).join(" + "), mobs: g.views.length, owner: owners.join(", ") || null,
      head: g.views.reduce((t, v) => t + v.state.head, 0), ae: Math.round(g.views.reduce((t, v) => t + aeOf(v), 0)),
      paddocks: g.paddocks.map((id) => pad.get(id)?.name ?? `#${id}`),
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
  return { as_of: proj.as_of, rules, mobs };
}
