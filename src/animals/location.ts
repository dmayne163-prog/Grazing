/**
 * Who was in a paddock on a day: the mobs whose recorded paddocks included
 * it then, and the animals in each of those mobs that day, by their own
 * join, leave and ending records. A mob's head count is its own record; the
 * animals listed are the ones the app can name, so the two can differ.
 */
import { db } from "../db/database.js";
import { allSegments } from "../stock/store.js";

const ENDS = new Set(["death", "sale", "gone"]);

export function paddockOnDate(paddockId: number, date: string) {
  const mobs = new Map((db.prepare("SELECT id, name, owner FROM mobs").all() as Array<{ id: number; name: string; owner: string | null }>).map((m) => [m.id, m]));
  const here = allSegments().filter((s) => s.paddock_ids.includes(paddockId) && s.from <= date && (s.to === null || date < s.to));
  const out = here.map((s) => {
    // Animals in this mob on the day: their last join/leave/ending on or before it.
    const events = db.prepare(`
      SELECT e.animal_id, e.date, e.kind, e.mob_id FROM animal_events e
      WHERE e.animal_id IN (SELECT DISTINCT animal_id FROM animal_events WHERE mob_id = ? AND kind = 'join')
        AND e.date <= ? AND (e.kind IN ('join', 'leave') OR e.kind IN ('death', 'sale', 'gone'))
      ORDER BY e.animal_id, e.date, e.id
    `).all(s.mob_id, date) as Array<{ animal_id: number; date: string; kind: string; mob_id: number | null }>;
    const inMob = new Map<number, boolean>();
    for (const e of events) {
      if (e.kind === "join") inMob.set(e.animal_id, e.mob_id === s.mob_id);
      else if (e.kind === "leave" && e.mob_id === s.mob_id) inMob.set(e.animal_id, false);
      else if (ENDS.has(e.kind)) inMob.set(e.animal_id, false);
    }
    const ids = [...inMob].filter(([, v]) => v).map(([id]) => id);
    const animals = ids.length
      ? db.prepare(`SELECT id, tag, eid, sex FROM animals WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY tag, eid`).all(...ids) as Array<{ id: number; tag: string | null; eid: string | null; sex: string | null }>
      : [];
    const m = mobs.get(s.mob_id);
    return {
      mob_id: s.mob_id, mob: m?.name ?? `mob #${s.mob_id}`, owner: m?.owner ?? null,
      head: s.head, from: s.from, to: s.to, inferred: s.inferred,
      with: s.paddock_ids.filter((p) => p !== paddockId).length,
      animals,
    };
  });
  return { date, mobs: out, head: out.reduce((t, m) => t + m.head, 0), named: out.reduce((t, m) => t + m.animals.length, 0) };
}
