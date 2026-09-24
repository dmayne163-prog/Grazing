/**
 * Individual animals: their records, their history, and bringing in
 * weighing sessions from the scales.
 *
 * An animal belongs to a mob through dated join and leave events, and gets
 * its paddocks from that mob's history — so an animal's paddock record is
 * never entered twice, and a move of the mob moves every animal in it.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { getFeature } from "../map/store.js";
import { StockError, type When } from "../stock/actions.js";
import { addEvent, allSegments, mobViews, type EventInput } from "../stock/store.js";
import type { ParsedSession, SessionRow } from "./session.js";

export interface AnimalRow {
  id: number;
  eid: string | null;
  tag: string | null;
  nlis: string | null;
  sex: string | null;
  breed: string | null;
  birth_date: string | null;
  origin: string | null;
  data: string;
  source: string;
  batch: string | null;
  created_at: number;
  updated_at: number;
}

export interface AnimalEventRow {
  id: number;
  animal_id: number;
  date: string;
  time: string | null;
  kind: string;
  mob_id: number | null;
  weight_kg: number | null;
  score: number | null;
  text: string | null;
  session_id: number | null;
  data: string;
  source: string;
  batch: string | null;
  username: string | null;
  created_at: number;
}

const ORDER = "date, IFNULL(time, ''), id";

function eventsOf(id: number): AnimalEventRow[] {
  return db.prepare(`SELECT * FROM animal_events WHERE animal_id = ? ORDER BY ${ORDER}`).all(id) as AnimalEventRow[];
}

/** Alive, dead or sold — from the animal's own events, never a stored flag. */
function statusOf(events: AnimalEventRow[]): { status: "alive" | "dead" | "sold"; date: string | null } {
  const end = [...events].reverse().find((e) => e.kind === "death" || e.kind === "sale");
  return end ? { status: end.kind === "death" ? "dead" : "sold", date: end.date } : { status: "alive", date: null };
}

/** The mob an animal is in at the end of its events, if any. */
function currentMob(events: AnimalEventRow[]): number | null {
  let mob: number | null = null;
  for (const e of events) {
    if (e.kind === "join") mob = e.mob_id;
    if (e.kind === "leave" && e.mob_id === mob) mob = null;
  }
  return mob;
}

const mobName = (id: number | null) =>
  id === null ? null : (db.prepare("SELECT name FROM mobs WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? `#${id}`;

/* --------------------------------- search -------------------------------- */

export interface AnimalSummary {
  id: number;
  eid: string | null;
  tag: string | null;
  nlis: string | null;
  status: string;
  mob_id: number | null;
  mob_name: string | null;
  last_weight_kg: number | null;
  last_weighed: string | null;
}

function summary(a: AnimalRow): AnimalSummary {
  const ev = eventsOf(a.id);
  const w = [...ev].reverse().find((e) => e.kind === "weigh" && e.weight_kg !== null);
  const mob = currentMob(ev);
  return {
    id: a.id, eid: a.eid, tag: a.tag, nlis: a.nlis, status: statusOf(ev).status,
    mob_id: mob, mob_name: mobName(mob),
    last_weight_kg: w?.weight_kg ?? null, last_weighed: w?.date ?? null,
  };
}

/**
 * Finds animals by EID (any run of its digits, spaces ignored), management
 * tag or NLIS number. "3719" finds PENJOBE3719; "726941" finds the EID
 * ending that way.
 */
export function searchAnimals(q: string, limit = 25): AnimalSummary[] {
  const text = q.trim();
  if (text.length < 2) return [];
  const digits = text.replace(/\D/g, "");
  const like = `%${text.replace(/[%_]/g, "")}%`;
  const rows = db.prepare(`
    SELECT * FROM animals
    WHERE tag LIKE ? COLLATE NOCASE OR nlis LIKE ? COLLATE NOCASE
       OR (? != '' AND eid LIKE ?)
    ORDER BY tag COLLATE NOCASE LIMIT ?
  `).all(like, like, digits.length >= 3 ? digits : "", `%${digits}%`, limit) as AnimalRow[];
  return rows.map(summary);
}

export function animalsInMob(mobId: number): AnimalSummary[] {
  const ids = db.prepare("SELECT DISTINCT animal_id FROM animal_events WHERE mob_id = ?").all(mobId) as Array<{ animal_id: number }>;
  return ids
    .map(({ animal_id }) => db.prepare("SELECT * FROM animals WHERE id = ?").get(animal_id) as AnimalRow)
    .map(summary)
    .filter((s) => s.mob_id === mobId)
    .sort((a, b) => (a.tag ?? "").localeCompare(b.tag ?? "", "en", { numeric: true }));
}

/* ---------------------------------- view --------------------------------- */

/**
 * One animal in full: its weights with the gain between each, the paddocks
 * it has been in (through its mobs), and everything recorded against it.
 */
export function animalView(id: number) {
  const a = db.prepare("SELECT * FROM animals WHERE id = ?").get(id) as AnimalRow | undefined;
  if (!a) return null;
  const ev = eventsOf(id);
  const st = statusOf(ev);
  const mob = currentMob(ev);

  const weights = ev.filter((e) => e.kind === "weigh" && e.weight_kg !== null).map((e, i, all) => {
    const prev = all[i - 1];
    const days = prev ? Math.round((Date.parse(`${e.date}T00:00:00Z`) - Date.parse(`${prev.date}T00:00:00Z`)) / 86_400_000) : null;
    return {
      id: e.id, date: e.date, weight_kg: e.weight_kg,
      gain_per_day: prev && days && days > 0 ? Math.round(((e.weight_kg! - prev.weight_kg!) / days) * 100) / 100 : null,
      session: e.session_id ? (db.prepare("SELECT name FROM weigh_sessions WHERE id = ?").get(e.session_id) as { name: string } | undefined)?.name ?? null : null,
      source: e.source, batch: e.batch,
    };
  });

  // Mob memberships, then the paddocks each mob was in during them.
  const spans: Array<{ mob_id: number; from: string; to: string | null }> = [];
  for (const e of ev) {
    if (e.kind === "join" && e.mob_id !== null) {
      const open = spans[spans.length - 1];
      if (open && open.to === null) open.to = e.date;
      spans.push({ mob_id: e.mob_id, from: e.date, to: null });
    }
    if ((e.kind === "leave" || e.kind === "death" || e.kind === "sale")) {
      const open = spans[spans.length - 1];
      if (open && open.to === null) open.to = e.date;
    }
  }
  const segs = allSegments();
  const paddocks: Array<{ from: string; to: string | null; mob_id: number; mob_name: string | null; paddocks: string[] }> = [];
  for (const s of spans) {
    for (const g of segs.filter((x) => x.mob_id === s.mob_id)) {
      const from = g.from > s.from ? g.from : s.from;
      const endA = g.to, endB = s.to;
      const to = endA === null ? endB : endB === null ? endA : endA < endB ? endA : endB;
      if (to !== null && to <= from) continue;
      const names = g.paddock_ids.map((p) => getFeature(p)?.name ?? `#${p}`);
      const last = paddocks[paddocks.length - 1];
      if (last && last.mob_id === s.mob_id && last.to === from && last.paddocks.join() === names.join()) {
        last.to = to;
      } else {
        paddocks.push({ from, to, mob_id: s.mob_id, mob_name: mobName(s.mob_id), paddocks: names });
      }
    }
  }

  return {
    animal: { ...a, data: JSON.parse(a.data) as Record<string, unknown> },
    status: st.status, status_date: st.date,
    mob_id: mob, mob_name: mobName(mob),
    weights, paddocks: paddocks.reverse(),
    events: [...ev].reverse().map((e) => ({
      id: e.id, date: e.date, time: e.time, kind: e.kind, mob_id: e.mob_id, mob_name: mobName(e.mob_id),
      weight_kg: e.weight_kg, score: e.score, text: e.text, source: e.source, batch: e.batch,
      data: JSON.parse(e.data) as Record<string, unknown>,
    })),
  };
}

/* ------------------------------ writing events --------------------------- */

function addAnimalEvent(
  animalId: number, e: { date: string; time?: string | null; kind: string; mob_id?: number | null; weight_kg?: number | null; score?: number | null; text?: string | null; session_id?: number | null; data?: Record<string, unknown> },
  source: string, username: string | null, batch: string
) {
  db.prepare(`
    INSERT INTO animal_events (animal_id, date, time, kind, mob_id, weight_kg, score, text, session_id, data, source, batch, username, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(animalId, e.date, e.time ?? null, e.kind, e.mob_id ?? null, e.weight_kg ?? null, e.score ?? null,
    e.text ?? null, e.session_id ?? null, JSON.stringify(e.data ?? {}), source, batch, username, Date.now());
}

function mustBeAnimal(id: number): AnimalEventRow[] {
  if (!db.prepare("SELECT 1 FROM animals WHERE id = ?").get(id)) throw new StockError("No such animal");
  return eventsOf(id);
}

export function weighAnimal(id: number, kgRaw: unknown, when: When, note: string | null, username: string | null) {
  mustBeAnimal(id);
  const kg = Number(kgRaw);
  if (!Number.isFinite(kg) || kg <= 0 || kg > 1500) throw new StockError("Enter the weight in kg");
  const batch = randomUUID();
  addAnimalEvent(id, { date: when.date, time: when.time, kind: "weigh", weight_kg: Math.round(kg * 10) / 10, text: note }, "app", username, batch);
  return { batch };
}

export function noteAnimal(id: number, text: string | null, when: When, username: string | null) {
  mustBeAnimal(id);
  if (!text) throw new StockError("Write the note");
  const batch = randomUUID();
  addAnimalEvent(id, { date: when.date, time: when.time, kind: "note", text }, "app", username, batch);
  return { batch };
}

/**
 * Records an animal's death. Its mob's head count drops by one as well —
 * unless the mob's numbers already allow for it (a death recorded in
 * AgriWebb before this animal had a record here), which the caller says.
 */
export function animalDeath(id: number, when: When, cause: string | null, alsoMob: boolean, username: string | null) {
  const ev = mustBeAnimal(id);
  if (statusOf(ev).status !== "alive") throw new StockError("This animal is already recorded as dead or sold");
  const mob = currentMob(ev.filter((e) => e.date <= when.date));
  const batch = randomUUID();
  db.transaction(() => {
    addAnimalEvent(id, { date: when.date, time: when.time, kind: "death", mob_id: mob, text: cause }, "app", username, batch);
    if (alsoMob && mob !== null) {
      if (!mobViews(when.date, when.time).some((v) => v.mob.id === mob)) {
        throw new StockError("Its mob had no head on that date, so its count can't be reduced");
      }
      const a = db.prepare("SELECT tag, eid FROM animals WHERE id = ?").get(id) as { tag: string | null; eid: string | null };
      addEvent(mob, {
        date: when.date, time: when.time, kind: "death", head_change: -1,
        data: { animal_id: id, animal: a.tag ?? a.eid, ...(cause ? { note: cause } : {}) },
      }, "app", username, batch);
    }
  })();
  return { batch };
}

/* ------------------------------- sessions -------------------------------- */

export interface SessionPlan {
  rows: Array<SessionRow & { animal_id: number | null; current_mob: string | null }>;
  existing: number;
  new_animals: number;
  mean_kg: number | null;
  suggestions: Array<{ mob_id: number; name: string; head: number | null; weight_kg: number | null; reasons: string[]; score: number }>;
  later_weighing: Record<number, { date: string; weight_kg: number }>;
}

function findAnimal(r: Pick<SessionRow, "eid" | "tag" | "nlis">): AnimalRow | null {
  if (r.eid) {
    const a = db.prepare("SELECT * FROM animals WHERE eid = ?").get(r.eid) as AnimalRow | undefined;
    if (a) return a;
  }
  if (r.nlis) {
    const a = db.prepare("SELECT * FROM animals WHERE nlis = ?").get(r.nlis) as AnimalRow | undefined;
    if (a) return a;
  }
  // A tag alone identifies an animal only where no EID says otherwise.
  if (r.tag && !r.eid) {
    const a = db.prepare("SELECT * FROM animals WHERE tag = ? COLLATE NOCASE").all(r.tag) as AnimalRow[];
    if (a.length === 1) return a[0]!;
  }
  return null;
}

/**
 * What importing a session would do, and which mob it most likely belongs
 * to: a mob the animals are already in; else one whose head, weight and name
 * fit the session.
 */
export function planSession(s: ParsedSession): SessionPlan {
  const rows = s.rows.map((r) => {
    const a = findAnimal(r);
    const mob = a ? currentMob(eventsOf(a.id)) : null;
    return { ...r, animal_id: a?.id ?? null, current_mob: mobName(mob) };
  });
  const weights = rows.map((r) => r.weight_kg).filter((w): w is number => w !== null);
  const mean = weights.length ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 10) / 10 : null;
  const n = rows.length;

  // Score every mob on hand around the session date, or now.
  const date = s.date ?? new Date().toISOString().slice(0, 10);
  const windowEnd = new Date(Date.parse(`${date}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  // Words that say something about which mob: "Penjobe", not "weaners".
  const COMMON = new Set(["weaners", "weaner", "purchased", "purchase", "heifers", "heifer", "steers", "steer", "cows",
    "bulls", "calves", "yearlings", "session", "info", "weigh", "weighing", "mob", "tag", "tags", "white", "blue", "red",
    "yellow", "purple", "green", "mixed", "cattle", "sale", "sold", "draft"]);
  const nameWords = s.name.toLowerCase().split(/\W+/).filter((w) => w.length >= 4 && !COMMON.has(w));
  const already = new Map<number, number>();
  for (const r of rows) {
    if (!r.animal_id) continue;
    const m = currentMob(eventsOf(r.animal_id));
    if (m !== null) already.set(m, (already.get(m) ?? 0) + 1);
  }
  const candidates = new Map<number, { view: ReturnType<typeof mobViews>[number]; when: string }>();
  for (const d of [date, windowEnd, new Date().toISOString().slice(0, 10)]) {
    for (const v of mobViews(d)) if (!candidates.has(v.mob.id)) candidates.set(v.mob.id, { view: v, when: d });
  }
  const suggestions: SessionPlan["suggestions"] = [];
  for (const { view: v } of candidates.values()) {
    const reasons: string[] = [];
    let score = 0;
    const inIt = already.get(v.mob.id) ?? 0;
    if (inIt) { score += 100 * inIt / n; reasons.push(`${inIt} of these animals are already in it`); }
    const headThen = v.state.head;
    const headNow = mobViews().find((x) => x.mob.id === v.mob.id)?.state.head ?? 0;
    const firstHead = (db.prepare("SELECT head FROM mob_events WHERE mob_id = ? AND kind = 'opening' ORDER BY date, id LIMIT 1").get(v.mob.id) as { head: number } | undefined)?.head ?? null;
    if (headNow === n) { score += 30; reasons.push(`${n} head now`); }
    else if (firstHead === n) { score += 30; reasons.push(`started with ${n} head`); }
    else if (headThen === n) { score += 25; reasons.push(`${n} head at the session date`); }
    else if (Math.abs(headNow - n) <= 2) { score += 15; reasons.push(`${headNow} head, close to ${n}`); }
    const w = v.state.est_weight_kg;
    if (mean !== null && w !== null && Math.abs(w - mean) <= 20) {
      score += 25 - Math.abs(w - mean);
      reasons.push(`${Math.round(w)} kg on record, session averages ${Math.round(mean)}`);
    }
    const text = `${v.mob.name} ${v.mob.description ?? ""}`.toLowerCase();
    const hits = nameWords.filter((wd) => text.includes(wd));
    if (hits.length) { score += 35; reasons.push(`its name or description says "${hits.join(", ")}"`); }
    const opened = (db.prepare("SELECT MIN(date) d FROM mob_events WHERE mob_id = ?").get(v.mob.id) as { d: string }).d;
    if (s.date && Math.abs(Date.parse(opened) - Date.parse(s.date)) <= 7 * 86_400_000) {
      score += 15; reasons.push(`started ${opened}, close to the session date`);
    }
    // Weight alone is weak evidence: plenty of mobs sit near any average.
    const onlyWeight = reasons.length === 1 && (reasons[0] ?? "").includes("kg on record");
    if (score > 0 && !onlyWeight) {
      suggestions.push({ mob_id: v.mob.id, name: v.mob.name, head: headNow, weight_kg: w, reasons, score: Math.round(score) });
    }
  }
  suggestions.sort((a, b) => b.score - a.score);

  // A later mob weighing stays current over this session's average.
  const later_weighing: SessionPlan["later_weighing"] = {};
  for (const sug of suggestions.slice(0, 5)) {
    const lw = db.prepare("SELECT date, weight_kg FROM mob_events WHERE mob_id = ? AND kind = 'weigh' AND weight_kg IS NOT NULL AND date > ? ORDER BY date DESC LIMIT 1")
      .get(sug.mob_id, date) as { date: string; weight_kg: number } | undefined;
    if (lw) later_weighing[sug.mob_id] = lw;
  }

  return {
    rows,
    existing: rows.filter((r) => r.animal_id !== null).length,
    new_animals: rows.filter((r) => r.animal_id === null).length,
    mean_kg: mean,
    suggestions: suggestions.slice(0, 5),
    later_weighing,
  };
}

/**
 * Brings a session in: new animals are created, every weight, score and note
 * recorded against its animal, the animals put in the chosen mob, and —
 * if asked — the mob's average weight set from the session. One batch, so
 * the whole session can be undone.
 */
export function commitSession(
  s: ParsedSession, opts: { mob_id: number | null; date: string | null; name: string | null; update_mob_weight: boolean; source: string; filename: string },
  username: string | null
): { batch: string; session_id: number; created: number; weighed: number } {
  const date = opts.date ?? s.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new StockError("The session needs a date");
  if (opts.mob_id !== null && !db.prepare("SELECT 1 FROM mobs WHERE id = ?").get(opts.mob_id)) throw new StockError("No such mob");
  const batch = randomUUID();
  const now = Date.now();

  return db.transaction(() => {
    const sid = Number(db.prepare(`
      INSERT INTO weigh_sessions (name, date, source, filename, animal_count, mob_id, batch, username, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run((opts.name ?? s.name).slice(0, 120), date, opts.source, opts.filename, s.rows.length, opts.mob_id, batch, username, now).lastInsertRowid);

    let created = 0, weighed = 0;
    const weights: number[] = [];
    for (const r of s.rows) {
      let a = findAnimal(r);
      if (!a) {
        const id = Number(db.prepare(`
          INSERT INTO animals (eid, tag, nlis, data, source, batch, created_at, updated_at)
          VALUES (?, ?, ?, '{}', ?, ?, ?, ?)
        `).run(r.eid, r.tag, r.nlis, `session:${sid}`, batch, now, now).lastInsertRowid);
        a = db.prepare("SELECT * FROM animals WHERE id = ?").get(id) as AnimalRow;
        created++;
      } else if ((!a.tag && r.tag) || (!a.nlis && r.nlis)) {
        db.prepare("UPDATE animals SET tag = COALESCE(tag, ?), nlis = COALESCE(nlis, ?), updated_at = ? WHERE id = ?")
          .run(r.tag, r.nlis, now, a.id);
      }
      const d = r.date ?? date;
      if (opts.mob_id !== null) {
        const mob = currentMob(eventsOf(a.id).filter((e) => e.date <= d));
        if (mob !== opts.mob_id) {
          if (mob !== null) addAnimalEvent(a.id, { date: d, kind: "leave", mob_id: mob, session_id: sid }, `session:${sid}`, username, batch);
          addAnimalEvent(a.id, { date: d, kind: "join", mob_id: opts.mob_id, session_id: sid }, `session:${sid}`, username, batch);
        }
      }
      if (r.weight_kg !== null) {
        addAnimalEvent(a.id, { date: d, kind: "weigh", weight_kg: r.weight_kg, session_id: sid, text: r.notes }, `session:${sid}`, username, batch);
        weights.push(r.weight_kg);
        weighed++;
      } else if (r.notes) {
        addAnimalEvent(a.id, { date: d, kind: "note", text: r.notes, session_id: sid }, `session:${sid}`, username, batch);
      }
      if (r.score !== null) addAnimalEvent(a.id, { date: d, kind: "score", score: r.score, session_id: sid }, `session:${sid}`, username, batch);
    }

    if (opts.update_mob_weight && opts.mob_id !== null && weights.length) {
      const mean = Math.round((weights.reduce((x, y) => x + y, 0) / weights.length) * 10) / 10;
      const e: EventInput = {
        date, kind: "weigh", weight_kg: mean,
        data: { method: "scales", head_weighed: weights.length, session_id: sid, note: `From session: ${opts.name ?? s.name}` },
      };
      addEvent(opts.mob_id, e, "app", username, batch);
    }
    return { batch, session_id: sid, created, weighed };
  })();
}
