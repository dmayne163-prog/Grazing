/**
 * Animals with a record but no mob here: ones an import (a TSi backup,
 * Optiweigh) brought in without knowing where they are now. Grouped by the
 * session they were last seen in — the lot they came through the yards with —
 * so a whole lot can be put into the mob it's in, or recorded as gone.
 *
 * Records only: no mob's head count changes. A mob is counted by its own
 * records; this just says which animals make up that count.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { StockError } from "../stock/actions.js";
import { mobViews } from "../stock/store.js";
import { addAnimalEvent, allSummaries } from "./store.js";

export interface UnplacedGroup {
  session_id: number | null;
  name: string;
  date: string | null;
  head: number;
  sexes: Record<string, number>;
}

/** Each unplaced animal's last session: the one it was last weighed or processed in. */
function lastSessions(ids: number[]) {
  const out = new Map<number, { session_id: number | null; date: string | null }>();
  const q = db.prepare(`
    SELECT e.session_id sid, e.date FROM animal_events e
    WHERE e.animal_id = ? AND e.session_id IS NOT NULL ORDER BY e.date DESC, e.id DESC LIMIT 1
  `);
  for (const id of ids) {
    const r = q.get(id) as { sid: number; date: string } | undefined;
    out.set(id, { session_id: r?.sid ?? null, date: r?.date ?? null });
  }
  return out;
}

function unplacedAnimals() {
  return allSummaries().filter((a) => a.status === "alive" && a.mob_id === null);
}

export function unplacedGroups(): UnplacedGroup[] {
  const animals = unplacedAnimals();
  const last = lastSessions(animals.map((a) => a.id));
  const sess = new Map((db.prepare("SELECT id, name, date FROM weigh_sessions").all() as Array<{ id: number; name: string; date: string }>).map((s) => [s.id, s]));
  const groups = new Map<string, UnplacedGroup>();
  for (const a of animals) {
    const l = last.get(a.id)!;
    const k = String(l.session_id ?? "none");
    const s = l.session_id !== null ? sess.get(l.session_id) : undefined;
    const g = groups.get(k) ?? { session_id: l.session_id, name: s?.name || (l.session_id !== null ? "unnamed session" : "no session"), date: s?.date ?? l.date, head: 0, sexes: {} };
    g.head++;
    const sex = a.sex ?? "not recorded";
    g.sexes[sex] = (g.sexes[sex] ?? 0) + 1;
    groups.set(k, g);
  }
  return [...groups.values()].sort((x, y) => (y.date ?? "").localeCompare(x.date ?? "") || y.head - x.head);
}

/**
 * Puts a group into a mob from the day it was last seen (or the mob's first
 * day, if later), or records it as gone. One batch, so one Undo reverses it.
 */
export function placeGroup(sessionId: number | null, target: number | "gone", username: string | null) {
  const animals = unplacedAnimals();
  const last = lastSessions(animals.map((a) => a.id));
  const chosen = animals.filter((a) => last.get(a.id)!.session_id === sessionId);
  if (!chosen.length) throw new StockError("No animals left in that group");
  const sess = sessionId !== null ? db.prepare("SELECT name, date FROM weigh_sessions WHERE id = ?").get(sessionId) as { name: string; date: string } | undefined : undefined;
  const label = sess ? `"${sess.name || "unnamed"}" ${sess.date}` : "no session";
  const batch = randomUUID();

  if (target !== "gone") {
    const v = mobViews().find((x) => x.mob.id === target);
    if (!v) throw new StockError("That mob isn't on hand");
    const have = allSummaries().filter((a) => a.status === "alive" && a.mob_id === target).length;
    if (have + chosen.length > v.state.head) {
      throw new StockError(`${v.mob.name} has ${v.state.head} hd and ${have} animal records already: ${chosen.length} more would be more animals than head. Check the group or recount the mob first.`);
    }
    const first = (db.prepare("SELECT MIN(date) d FROM mob_events WHERE mob_id = ?").get(target) as { d: string | null }).d;
    db.transaction(() => {
      for (const a of chosen) {
        const seen = last.get(a.id)!.date ?? first ?? "";
        addAnimalEvent(a.id, { date: first && first > seen ? first : seen, kind: "join", mob_id: target, data: { from: `placed from ${label}` } }, "app", username, batch);
      }
    })();
    return { batch, placed: chosen.length, summary: `${chosen.length} animal${chosen.length === 1 ? "" : "s"} last seen in ${label} put in ${v.mob.name}` };
  }
  db.transaction(() => {
    for (const a of chosen) {
      const seen = last.get(a.id)!.date ?? new Date().toISOString().slice(0, 10);
      addAnimalEvent(a.id, { date: seen, kind: "gone", text: `Not in any mob here; last seen in ${label}`, data: { from: "placing", last_seen: seen } }, "app", username, batch);
    }
  })();
  return { batch, placed: chosen.length, summary: `${chosen.length} animal${chosen.length === 1 ? "" : "s"} last seen in ${label} recorded as off the books` };
}
