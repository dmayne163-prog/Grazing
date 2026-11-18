/**
 * Cattle on and off the property between two dates, as consignments: every
 * purchase, sale and transfer on or off farm in the head count register,
 * grouped by day and direction, with own and agisted head kept apart.
 *
 * Beside each one is what the outside records say happened around then —
 * NLIS move-offs and move-ons, and the scales' "last seen before they went"
 * — so a consignment recorded with the wrong head, or one missing from the
 * books altogether, stands out. Deaths and recounts in the period are listed
 * under it, because they move the numbers too.
 */
import { db } from "../db/database.js";
import { headRegister, type RegisterRow } from "./register.js";

const IN = new Set(["Purchase", "Transfer on to farm", "New mob"]);
const OUT = new Set(["Sale", "Transfer off farm"]);
/** How far apart a consignment and an NLIS/scales record may be and still be the same truck. */
const NEAR_DAYS = 3;

export interface ConsignmentLine { mob: string; owner: string | null; head: number; what: string; notes: string[] }
export interface Evidence { date: string; direction: "on" | "off"; source: string; place: string | null; head: number }
export interface Consignment {
  date: string; direction: "on" | "off"; head: number; own: number; agisted: number;
  owners: string[]; lines: ConsignmentLine[]; evidence: Evidence[];
}

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const shift = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

/** NLIS and scales records of cattle leaving or arriving, a few days either side of the period. */
function outsideRecords(from: string, to: string): Evidence[] {
  const lo = shift(from, -NEAR_DAYS), hi = shift(to, NEAR_DAYS);
  const offs = db.prepare(`SELECT date, kind, json_extract(data, '$.from') src, json_extract(data, '$.destination') place, count(*) n
    FROM animal_events WHERE kind IN ('sale', 'gone') AND date BETWEEN ? AND ? GROUP BY date, kind, src, place`).all(lo, hi) as
    Array<{ date: string; kind: string; src: string | null; place: string | null; n: number }>;
  const ons = db.prepare(`SELECT date, pic, count(*) n FROM nlis_movements WHERE direction = 'on' AND date BETWEEN ? AND ? GROUP BY date, pic`).all(lo, hi) as
    Array<{ date: string; pic: string | null; n: number }>;
  return [
    ...offs.map((r) => ({
      date: r.date, direction: "off" as const, head: r.n, place: r.place,
      source: r.src === "NLIS" ? "NLIS move-off" : r.src === "TSi" ? "last seen on the scales" : r.kind === "sale" ? "animal records (sold)" : "animal records (gone)",
    })),
    ...ons.map((r) => ({ date: r.date, direction: "on" as const, head: r.n, place: r.pic ? `from ${r.pic}` : null, source: "NLIS move-on" })),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

export function movements(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("Dates must be YYYY-MM-DD");
  const reg = headRegister({ from, to, property_only: true });
  const rows = reg.rows.filter((r) => r.status === "counted").reverse();

  const byKey = new Map<string, Consignment>();
  for (const r of rows) {
    const dir = IN.has(r.what) ? "on" : OUT.has(r.what) ? "off" : null;
    if (!dir || r.change === 0) continue;
    const key = `${r.date}|${dir}`;
    const c = byKey.get(key) ?? { date: r.date, direction: dir, head: 0, own: 0, agisted: 0, owners: [], lines: [], evidence: [] };
    const n = Math.abs(r.change);
    c.head += n;
    if (r.owner) { c.agisted += n; if (!c.owners.includes(r.owner)) c.owners.push(r.owner); } else c.own += n;
    // Several records for the same mob on the same day (AgriWebb often splits a sale) become one line.
    const same = c.lines.find((l) => l.mob === r.mob && l.what === r.what);
    if (same) { same.head += n; for (const x of r.notes) if (!same.notes.includes(x)) same.notes.push(x); }
    else c.lines.push({ mob: r.mob, owner: r.owner, head: n, what: r.what, notes: [...r.notes] });
    byKey.set(key, c);
  }
  const consignments = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.direction.localeCompare(b.direction));

  // Each outside record goes to one consignment the same way within a few
  // days: one it still fits into (head not yet accounted for) if there is
  // one, the nearest in date among those.
  const unmatched: Evidence[] = [];
  const left = (c: Consignment) => c.head - c.evidence.reduce((t, e) => t + e.head, 0);
  for (const ev of outsideRecords(from, to)) {
    let best: Consignment | null = null;
    const better = (c: Consignment, b: Consignment) => {
      const fc = left(c) >= ev.head, fb = left(b) >= ev.head;
      return fc !== fb ? fc : days(c.date, ev.date) < days(b.date, ev.date);
    };
    for (const c of consignments) {
      if (c.direction !== ev.direction || days(c.date, ev.date) > NEAR_DAYS) continue;
      if (!best || better(c, best)) best = c;
    }
    if (best) best.evidence.push(ev);
    else if (ev.date >= from && ev.date <= to) unmatched.push(ev);
  }

  const counted = (what: (r: RegisterRow) => boolean) => rows.filter(what);
  const deaths = counted((r) => r.what === "Death").map((r) => ({ date: r.date, mob: r.mob, owner: r.owner, head: -r.change, notes: r.notes }));
  const recounts = counted((r) => r.what === "Recount" && r.change !== 0).map((r) => ({ date: r.date, mob: r.mob, owner: r.owner, change: r.change, before: r.before, after: r.after, notes: r.notes }));
  // Anything else that changed the total: chiefly the opening counts when records began.
  const other = counted((r) => !IN.has(r.what) && !OUT.has(r.what) && r.what !== "Death" && r.what !== "Recount" && r.change !== 0)
    .map((r) => ({ date: r.date, mob: r.mob, owner: r.owner, change: r.change, what: r.what, notes: r.notes }));
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0);
  const ons = consignments.filter((c) => c.direction === "on"), offs = consignments.filter((c) => c.direction === "off");

  // Head on hand at the start and end, from the register's running total.
  const all = headRegister({ property_only: true }).rows.filter((r) => r.status === "counted").reverse();
  const at = (date: string, inclusive: boolean) => {
    let t = 0;
    for (const r of all) if (inclusive ? r.date <= date : r.date < date) t = r.property_after;
    return t;
  };

  return {
    from, to,
    consignments, unmatched, deaths, recounts, other,
    totals: {
      on: { own: sum(ons, (c) => c.own), agisted: sum(ons, (c) => c.agisted) },
      off: { own: sum(offs, (c) => c.own), agisted: sum(offs, (c) => c.agisted) },
      deaths: { own: sum(deaths.filter((x) => !x.owner), (x) => x.head), agisted: sum(deaths.filter((x) => x.owner), (x) => x.head) },
      recounts: sum(recounts, (x) => x.change),
      other: sum(other, (x) => x.change),
    },
    on_hand: { start: at(from, false), end: at(to, true) },
  };
}
