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
import { picName } from "./nlis.js";

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

export function eventsOf(id: number): AnimalEventRow[] {
  return db.prepare(`SELECT * FROM animal_events WHERE animal_id = ? ORDER BY ${ORDER}`).all(id) as AnimalEventRow[];
}

/**
 * Alive, dead, sold or gone — from the animal's own events, never a stored
 * flag. "Gone" is off the books without a record of how: written off in TSi,
 * or trucked out and never marked.
 */
const ENDS = ["death", "sale", "gone"];
export function statusOf(events: AnimalEventRow[]): { status: "alive" | "dead" | "sold" | "gone"; date: string | null } {
  const end = [...events].reverse().find((e) => ENDS.includes(e.kind));
  return end ? { status: end.kind === "death" ? "dead" : end.kind === "sale" ? "sold" : "gone", date: end.date } : { status: "alive", date: null };
}

/** The mob an animal is in at the end of its events, if any. */
export function currentMob(events: AnimalEventRow[]): number | null {
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
  sex: string | null;
  breed: string | null;
  birth_date: string | null;
  status_date: string | null;
  status: string;
  mob_id: number | null;
  mob_name: string | null;
  last_weight_kg: number | null;
  last_weighed: string | null;
}

function summary(a: AnimalRow, events?: AnimalEventRow[]): AnimalSummary {
  const ev = events ?? eventsOf(a.id);
  const w = [...ev].reverse().find((e) => e.kind === "weigh" && e.weight_kg !== null);
  const mob = currentMob(ev);
  const st = statusOf(ev);
  return {
    id: a.id, eid: a.eid, tag: a.tag, nlis: a.nlis, sex: a.sex, breed: a.breed, birth_date: a.birth_date,
    status: st.status, status_date: st.date,
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
  return rows.map((a) => summary(a));
}

/**
 * Every animal, for the Animals tab: filtered by status and mob, optionally
 * narrowed by the same text search as the search box. Sold and dead animals
 * are included when asked for — their history is kept.
 */
export function listAnimals(opts: { q?: string; status?: string; mob?: number | null; limit?: number }): { total: number; animals: AnimalSummary[] } {
  const rows = opts.q && opts.q.trim().length >= 2
    ? searchAnimals(opts.q, 5000)
    : allSummaries();
  // "On hand" is alive and in a mob; "not in a mob" is alive with no mob here.
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  const fits = (a: AnimalSummary) =>
    status === null ? true
      : status === "onhand" ? a.status === "alive" && a.mob_id !== null
        : status === "unplaced" ? a.status === "alive" && a.mob_id === null
          : a.status === status;
  const filtered = rows.filter((a) => fits(a) && (opts.mob == null || a.mob_id === opts.mob));
  return { total: filtered.length, animals: filtered.slice(0, opts.limit ?? 500) };
}

/** Every animal, its events read in one pass rather than one query each. */
export function allSummaries(): AnimalSummary[] {
  const byAnimal = new Map<number, AnimalEventRow[]>();
  for (const e of db.prepare(`SELECT * FROM animal_events ORDER BY ${ORDER}`).all() as AnimalEventRow[]) {
    const list = byAnimal.get(e.animal_id);
    if (list) list.push(e); else byAnimal.set(e.animal_id, [e]);
  }
  return (db.prepare("SELECT * FROM animals ORDER BY tag COLLATE NOCASE, id").all() as AnimalRow[])
    .map((a) => summary(a, byAnimal.get(a.id) ?? []));
}

/* ---------------------------------- edit --------------------------------- */

const SEXES = ["female", "male", "steer", "stag"];

/** Corrects or fills in what an animal is: tags, sex, breed, birth date, origin. */
export function updateAnimal(id: number, input: Record<string, unknown>): void {
  const a = db.prepare("SELECT * FROM animals WHERE id = ?").get(id) as AnimalRow | undefined;
  if (!a) throw new StockError("No such animal");
  const txt = (k: string, max = 60) => {
    if (!(k in input)) return (a as unknown as Record<string, string | null>)[k] ?? null;
    const v = input[k];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  };
  let eid = a.eid;
  if ("eid" in input) {
    const raw = typeof input["eid"] === "string" ? input["eid"].replace(/\D/g, "") : "";
    eid = raw === "" ? null : raw;
    if (eid !== null && eid.length < 10) throw new StockError("An EID is 15 digits");
    if (eid !== null && eid !== a.eid && db.prepare("SELECT 1 FROM animals WHERE eid = ? AND id != ?").get(eid, id)) {
      throw new StockError("Another animal already has that EID");
    }
  }
  const sex = "sex" in input ? (SEXES.includes(String(input["sex"])) ? String(input["sex"]) : null) : a.sex;
  const birth = txt("birth_date", 10);
  if (birth !== null && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) throw new StockError("Give the birth date as a date");
  db.prepare(`
    UPDATE animals SET eid = ?, tag = ?, nlis = ?, sex = ?, breed = ?, birth_date = ?, origin = ?, updated_at = ?
    WHERE id = ?
  `).run(eid, txt("tag"), txt("nlis", 20), sex, txt("breed"), birth, txt("origin", 120), Date.now(), id);
}

/**
 * Sets the sex of a mob's animals in one go — a heifer mob is all female.
 * Only animals with no sex recorded are touched unless told otherwise, so a
 * steer that was recorded one by one isn't overwritten.
 */
export function setSexForMob(mobId: number, sex: string, onlyMissing: boolean): { updated: number } {
  if (!SEXES.includes(sex)) throw new StockError("Choose female, steer or bull");
  const ids = animalsInMob(mobId).filter((a) => a.status === "alive" && (!onlyMissing || !a.sex)).map((a) => a.id);
  const upd = db.prepare("UPDATE animals SET sex = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => { for (const id of ids) upd.run(sex, Date.now(), id); })();
  return { updated: ids.length };
}

export function animalsInMob(mobId: number): AnimalSummary[] {
  const ids = db.prepare("SELECT DISTINCT animal_id FROM animal_events WHERE mob_id = ?").all(mobId) as Array<{ animal_id: number }>;
  return ids
    .map(({ animal_id }) => db.prepare("SELECT * FROM animals WHERE id = ?").get(animal_id) as AnimalRow)
    .map((a) => summary(a))
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
  const spans: Array<{ mob_id: number; from: string; to: string | null; assumed?: boolean }> = [];
  for (const e of ev) {
    if (e.kind === "join" && e.mob_id !== null) {
      const open = spans[spans.length - 1];
      if (open && open.to === null) open.to = e.date;
      spans.push({ mob_id: e.mob_id, from: e.date, to: null });
    }
    if (e.kind === "leave" || ENDS.includes(e.kind)) {
      const open = spans[spans.length - 1];
      if (open && open.to === null) open.to = e.date;
    }
  }
  // Before its first recorded mob, an animal is assumed to have been with the
  // mob that one was drafted from that day (Heavy Heifers came out of Number 5
  // on 2 Oct), back to when it arrived. One that left without ever being put
  // in a mob is assumed to have been in the mob with a sale recorded within a
  // few days of its leaving. Both are shown as assumed, not recorded.
  {
    const nl = a.eid ? db.prepare("SELECT direction, date FROM nlis_movements WHERE eid = ? ORDER BY date").all(a.eid) as Array<{ direction: string; date: string }> : [];
    const arrivedAt = nl.find((n) => n.direction === "on")?.date ?? ev[0]?.date ?? null;
    const end = ev.find((e) => ENDS.includes(e.kind));
    const firstDay = (mobId: number) => (db.prepare("SELECT MIN(date) d FROM mob_events WHERE mob_id = ?").get(mobId) as { d: string | null }).d;
    const parentOf = (mobId: number, onDate: string): number | null => {
      for (const e of db.prepare("SELECT kind, data FROM mob_events WHERE mob_id = ? AND date = ? AND kind IN ('opening', 'transfer')").all(mobId, onDate) as Array<{ kind: string; data: string }>) {
        const d = JSON.parse(e.data) as Record<string, unknown>;
        const p = d["drafted_from"] ?? (e.kind === "opening" ? d["from_mob"] : undefined) ?? (e.kind === "transfer" && !d["merged"] ? d["from_mob"] : undefined);
        if (typeof p === "number") return p;
      }
      return null;
    };
    let mobBefore: number | null = null, until: string | null = null;
    if (spans.length && arrivedAt && spans[0]!.from > arrivedAt) {
      const first = spans[0]!;
      mobBefore = parentOf(first.mob_id, first.from) ?? first.mob_id;
      until = first.from;
    } else if (!spans.length && end && arrivedAt) {
      const sold = db.prepare(`SELECT mob_id, -SUM(head_change) head FROM mob_events WHERE kind = 'sale' AND date BETWEEN date(?, '-5 days') AND date(?, '+2 days')
        GROUP BY mob_id ORDER BY ABS(julianday(MIN(date)) - julianday(?)), head DESC`).all(end.date, end.date, end.date) as Array<{ mob_id: number; head: number }>;
      if (sold.length) { mobBefore = sold[0]!.mob_id; until = end.date; }
    }
    // And back through the mobs each was drafted or split from, to its arrival.
    for (let depth = 0; mobBefore !== null && until !== null && depth < 8; depth++) {
      const start = firstDay(mobBefore);
      const from = start && arrivedAt! < start ? start : arrivedAt!;
      if (from < until) spans.unshift({ mob_id: mobBefore, from, to: until, assumed: true });
      if (!start || start <= arrivedAt!) break;
      const parent = parentOf(mobBefore, start);
      if (parent === null || parent === mobBefore) break;
      mobBefore = parent;
      until = start;
    }
  }
  const segs = allSegments();
  type Stay = { from: string; to: string | null; mob_id: number | null; mob_name: string | null; paddocks: string[]; inferred: boolean; seen: string[]; known: boolean; assumed: boolean };
  const paddocks: Stay[] = [];
  for (const s of spans) {
    for (const g of segs.filter((x) => x.mob_id === s.mob_id)) {
      const from = g.from > s.from ? g.from : s.from;
      const endA = g.to, endB = s.to;
      const to = endA === null ? endB : endB === null ? endA : endA < endB ? endA : endB;
      if (to !== null && to <= from) continue;
      const names = g.paddock_ids.map((p) => getFeature(p)?.name ?? `#${p}`);
      const last = paddocks[paddocks.length - 1];
      if (last && last.mob_id === s.mob_id && last.to === from && last.paddocks.join() === names.join() && last.inferred === g.inferred && last.assumed === !!s.assumed) {
        last.to = to;
      } else {
        paddocks.push({ from, to, mob_id: s.mob_id, mob_name: mobName(s.mob_id), paddocks: names, inferred: g.inferred, seen: [], known: true, assumed: !!s.assumed });
      }
    }
  }
  paddocks.sort((x, y) => x.from.localeCompare(y.from));

  // On the property from arrival to leaving: NLIS's dates where it has them,
  // else the first and last records here. Any part of that with no paddock
  // (before mob records began, or a mob with no moves recorded) is listed
  // as on the property, paddock not recorded.
  const nlis = a.eid ? db.prepare("SELECT direction, pic, date FROM nlis_movements WHERE eid = ? ORDER BY date").all(a.eid) as Array<{ direction: string; pic: string | null; date: string }> : [];
  const arrived = nlis.find((n) => n.direction === "on")?.date ?? ev[0]?.date ?? null;
  const ending = ev.find((e) => ENDS.includes(e.kind));
  const left = ending?.date ?? nlis.find((n) => n.direction === "off")?.date ?? null;
  if (arrived) {
    const filled: Stay[] = [];
    let cursor = arrived;
    for (const p of paddocks) {
      if (p.from > cursor) filled.push({ from: cursor, to: p.from, mob_id: null, mob_name: null, paddocks: [], inferred: false, seen: [], known: false, assumed: false });
      filled.push(p);
      if (p.to === null) { cursor = "9999"; break; }
      if (p.to > cursor) cursor = p.to;
    }
    if (cursor !== "9999" && (!left || cursor < left)) {
      filled.push({ from: cursor, to: left, mob_id: null, mob_name: null, paddocks: [], inferred: false, seen: [], known: false, assumed: false });
    }
    paddocks.splice(0, paddocks.length, ...filled.filter((p) => !(p.to !== null && p.to <= p.from)));
  }
  // The days it was handled here (weighed, processed) fall in a stay as proof it was there.
  // TSi's "Weal Paddock" trait says which paddock, where it was recorded.
  for (const e of ev) {
    if (!["weigh", "treatment", "score"].includes(e.kind) || e.source === "optiweigh") continue;
    const p = paddocks.find((x) => x.from <= e.date && (x.to === null || e.date < x.to));
    if (!p) continue;
    const said = e.text?.match(/Paddock ([^·]+)/)?.[1]?.trim();
    const tag = said ? `${e.date} (paddock ${said})` : e.date;
    if (!p.seen.includes(tag) && !p.seen.some((x) => x.startsWith(e.date))) p.seen.push(tag);
  }

  return {
    animal: { ...a, data: JSON.parse(a.data) as Record<string, unknown> },
    status: st.status, status_date: st.date,
    mob_id: mob, mob_name: mobName(mob),
    weights, paddocks: paddocks.reverse(),
    arrived, left,
    nlis: nlis.map((n) => ({ ...n, name: picName(n.pic) })),
    events: [...ev].reverse().map((e) => ({
      id: e.id, date: e.date, time: e.time, kind: e.kind, mob_id: e.mob_id, mob_name: mobName(e.mob_id),
      weight_kg: e.weight_kg, score: e.score, text: e.text, source: e.source, batch: e.batch,
      data: JSON.parse(e.data) as Record<string, unknown>,
    })),
  };
}

/* ------------------------------ writing events --------------------------- */

export function addAnimalEvent(
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
  const mob = currentMob(eventsOf(id));
  if (mob !== null) reconcileMobWeight(mob, username, batch);
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

/**
 * Records an animal sold: where to, and optionally its sale weight and price.
 * Like a death, it can also take a head off its mob — unless the mob's count
 * already allows for the sale.
 */
export function animalSale(
  id: number, when: When,
  input: { destination?: unknown; weight_kg?: unknown; price?: unknown; price_unit?: unknown; note?: unknown; also_mob?: unknown },
  username: string | null
) {
  const ev = mustBeAnimal(id);
  if (statusOf(ev).status !== "alive") throw new StockError("This animal is already recorded as dead or sold");
  const clean = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const weight = input.weight_kg === undefined || input.weight_kg === null || input.weight_kg === "" ? null : Number(input.weight_kg);
  if (weight !== null && (!Number.isFinite(weight) || weight <= 0 || weight > 1500)) throw new StockError("Sale weight must be in kg");
  const price = input.price === undefined || input.price === null || input.price === "" ? null : Number(input.price);
  if (price !== null && (!Number.isFinite(price) || price < 0)) throw new StockError("Price must be a number");
  const unit = ["c/kg", "$/hd"].includes(String(input.price_unit)) ? String(input.price_unit) : null;
  const mob = currentMob(ev.filter((e) => e.date <= when.date));
  const batch = randomUUID();
  db.transaction(() => {
    if (weight !== null) {
      addAnimalEvent(id, { date: when.date, time: when.time, kind: "weigh", weight_kg: weight, text: "Sale weight" }, "app", username, batch);
    }
    addAnimalEvent(id, {
      date: when.date, time: when.time, kind: "sale", mob_id: mob, text: clean(input.note, 500),
      data: {
        ...(clean(input.destination) ? { destination: clean(input.destination) } : {}),
        ...(price !== null ? { price, price_unit: unit ?? "$/hd" } : {}),
      },
    }, "app", username, batch);
    if (input.also_mob !== false && mob !== null) {
      if (!mobViews(when.date, when.time).some((v) => v.mob.id === mob)) {
        throw new StockError("Its mob had no head on that date, so its count can't be reduced");
      }
      const a = db.prepare("SELECT tag, eid FROM animals WHERE id = ?").get(id) as { tag: string | null; eid: string | null };
      addEvent(mob, {
        date: when.date, time: when.time, kind: "sale", head_change: -1,
        data: { animal_id: id, animal: a.tag ?? a.eid, ...(clean(input.destination) ? { note: `to ${clean(input.destination)}` } : {}) },
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
  s: ParsedSession, opts: { mob_id: number | null; date: string | null; name: string | null; update_mob_weight: boolean; source: string; filename: string; sold?: { destination: string | null } | null },
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
      // The same weighing brought in twice (a session imported again, or
      // exported from both the scales and APS) is only recorded once.
      const already = r.weight_kg !== null && !!db.prepare(
        "SELECT 1 FROM animal_events WHERE animal_id = ? AND kind = 'weigh' AND date = ? AND weight_kg = ?"
      ).get(a.id, d, r.weight_kg);
      if (r.weight_kg !== null && !already) {
        addAnimalEvent(a.id, { date: d, kind: "weigh", weight_kg: r.weight_kg, session_id: sid, text: r.notes }, `session:${sid}`, username, batch);
        weights.push(r.weight_kg);
        weighed++;
      } else if (r.notes) {
        addAnimalEvent(a.id, { date: d, kind: "note", text: r.notes, session_id: sid }, `session:${sid}`, username, batch);
      }
      if (r.score !== null) addAnimalEvent(a.id, { date: d, kind: "score", score: r.score, session_id: sid }, `session:${sid}`, username, batch);
      // The reader's draft and every data field, for reports to filter on.
      const fieldIns = db.prepare("INSERT INTO session_fields (session_id, animal_id, field, value, batch) VALUES (?, ?, ?, ?, ?)");
      if (r.draft) fieldIns.run(sid, a.id, "Draft", r.draft, batch);
      for (const [k, v] of Object.entries(r.fields ?? {})) fieldIns.run(sid, a.id, k, v, batch);
      // Sex from the scales fills in an animal that has none; it never overwrites one set by hand.
      if (r.sex && !a.sex) db.prepare("UPDATE animals SET sex = ?, updated_at = ? WHERE id = ?").run(r.sex, now, a.id);
      // A sale session: each animal is recorded as sold on the day. Mob head
      // counts are left alone — for past sales the mob history already has
      // them, from AgriWebb or from before records began.
      if (opts.sold && statusOf(eventsOf(a.id)).status === "alive") {
        addAnimalEvent(a.id, {
          date: d, kind: "sale", session_id: sid,
          data: opts.sold.destination ? { destination: opts.sold.destination } : {},
        }, `session:${sid}`, username, batch);
      }
    }

    if (opts.update_mob_weight && opts.mob_id !== null && weights.length) {
      const mean = Math.round((weights.reduce((x, y) => x + y, 0) / weights.length) * 10) / 10;
      // Timed after anything else recorded on the mob that day: a weighing
      // with no time sorts first, so a weight carried over by a same-day
      // draft would otherwise stand in for the scales.
      const sameDay = db.prepare("SELECT MAX(time) t FROM mob_events WHERE mob_id = ? AND date = ?").get(opts.mob_id, date) as { t: string | null };
      const e: EventInput = {
        date, time: sameDay.t && sameDay.t > "23:58" ? "23:59" : sameDay.t ? bump(sameDay.t) : null, kind: "weigh", weight_kg: mean,
        data: { method: "scales", head_weighed: weights.length, session_id: sid, note: `From session: ${opts.name ?? s.name}` },
      };
      addEvent(opts.mob_id, e, "app", username, batch);
    }
    // Weights in the session not set on the mob above still bring its weight up to date.
    if (opts.mob_id !== null && !opts.sold) reconcileMobWeight(opts.mob_id, username, batch);
    return { batch, session_id: sid, created, weighed };
  })();
}

/* -------------------------------- Optiweigh -------------------------------- */

/**
 * Optiweigh's raw individual data ("individuals_raw_data_….csv"): one row per
 * animal per day it walked over the unit — date, EID, visual ID (often blank)
 * and the day's weight. The download is cumulative, so importing a newer one
 * only adds what's new.
 */
export interface OptiweighRow { date: string; eid: string; vid: string | null; kg: number }

export function isOptiweigh(text: string): boolean {
  return /^\s*date\s*,\s*eid\s*,\s*vid\s*,\s*weight/i.test(text.slice(0, 200));
}

export function parseOptiweigh(text: string): OptiweighRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const at = (re: RegExp) => head.findIndex((h) => re.test(h));
  const iDate = at(/^date$/), iEid = at(/^eid$/), iVid = at(/^vid$/), iKg = at(/^weight/);
  if (iDate < 0 || iEid < 0 || iKg < 0) throw new StockError("This isn't Optiweigh's raw data: it needs date, eid and weight columns");
  const out: OptiweighRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const date = (c[iDate] ?? "").trim();
    const eid = (c[iEid] ?? "").replace(/\D/g, "");
    const kg = Number(c[iKg]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || eid.length < 10 || !Number.isFinite(kg) || kg <= 0 || kg > 1500) continue;
    const vid = iVid >= 0 ? (c[iVid] ?? "").trim() : "";
    out.push({ date, eid, vid: vid || null, kg: Math.round(kg * 10) / 10 });
  }
  if (!out.length) throw new StockError("No weights in this file");
  return out;
}

const weekOf = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** Weeks with fewer animals over the unit than this don't set the mob's weight. */
const MIN_WEEK_HEAD = 15;

/** Each week: the animals over the unit, each with its weights that week, and the week's last day weighed. */
function weeksOf(rows: OptiweighRow[]): Array<{ week: string; last: string; animals: Map<string, number[]> }> {
  const weeks = new Map<string, { week: string; last: string; animals: Map<string, number[]> }>();
  for (const r of rows) {
    const k = weekOf(r.date);
    const w = weeks.get(k) ?? { week: k, last: r.date, animals: new Map<string, number[]>() };
    w.animals.set(r.eid, [...(w.animals.get(r.eid) ?? []), r.kg]);
    if (r.date > w.last) w.last = r.date;
    weeks.set(k, w);
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/**
 * The mob's daily gain at a week, from the same animals weighed three to six
 * weeks earlier: each animal's change over the days between, averaged. A
 * different handful walks over the unit each week, so comparing two weeks'
 * medians would mostly measure who turned up.
 */
function pairedGain(w: { last: string; animals: Map<string, number[]> }, weeks: Array<{ last: string; animals: Map<string, number[]> }>): number | null {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const earlier = weeks.filter((x) => day(w.last) - day(x.last) >= 21 && day(w.last) - day(x.last) <= 42)
    .sort((a, b) => day(b.last) - day(a.last))[0];
  if (!earlier) return null;
  const days = day(w.last) - day(earlier.last);
  const gains: number[] = [];
  for (const [eid, kgs] of w.animals) {
    const before = earlier.animals.get(eid);
    if (before) gains.push((median(kgs) - median(before)) / days);
  }
  if (gains.length < 10) return null;
  return Math.round((gains.reduce((t, g) => t + g, 0) / gains.length) * 100) / 100;
}

export function planOptiweigh(rows: OptiweighRow[]) {
  const byEid = new Map<string, OptiweighRow[]>();
  for (const r of rows) byEid.set(r.eid, [...(byEid.get(r.eid) ?? []), r]);
  const dates = rows.map((r) => r.date).sort();
  const known = new Map<number, number>(); // mob → animals already in it
  let existing = 0, newWeights = 0;
  for (const [eid, list] of byEid) {
    const a = db.prepare("SELECT id FROM animals WHERE eid = ?").get(eid) as { id: number } | undefined;
    if (a) {
      existing++;
      const m = currentMob(eventsOf(a.id));
      if (m !== null) known.set(m, (known.get(m) ?? 0) + 1);
      for (const r of list) {
        if (!db.prepare("SELECT 1 FROM animal_events WHERE animal_id = ? AND kind = 'weigh' AND date = ? AND weight_kg = ?").get(a.id, r.date, r.kg)) newWeights++;
      }
    } else newWeights += list.length;
  }
  const full = weeksOf(rows).filter((w) => w.animals.size >= MIN_WEEK_HEAD);
  const recent = full.length ? full[full.length - 1]! : null;
  const recentKg = recent ? Math.round(median([...recent.animals.values()].map(median))) : null;

  // Which mob: one the animals are already in; else one with at least as many
  // head as there are animals, closest in weight.
  const n = byEid.size;
  const suggestions = mobViews().map((v) => {
    const reasons: string[] = [];
    let score = 0;
    const inIt = known.get(v.mob.id) ?? 0;
    if (inIt) { score += 100 * inIt / n; reasons.push(`${inIt} of these animals are already in it`); }
    if (v.state.head >= n * 0.9) { score += 20; reasons.push(`${v.state.head} head, enough for the ${n} animals weighed`); }
    const w = v.state.est_weight_kg;
    if (recentKg !== null && w !== null && Math.abs(w - recentKg) <= 60) {
      score += 30 - Math.abs(w - recentKg) / 2;
      reasons.push(`${Math.round(w)} kg on record; Optiweigh's latest week ${recentKg} kg`);
    }
    if (v.mob.owner) reasons.push(`agisted (${v.mob.owner})`);
    return { mob_id: v.mob.id, name: v.mob.name, head: v.state.head, weight_kg: w, reasons, score: Math.round(score) };
  }).filter((s) => s.score >= 25).sort((a, b) => b.score - a.score).slice(0, 5);

  return {
    animals: n, existing, new_animals: n - existing, weights: rows.length, new_weights: newWeights,
    from: dates[0]!, to: dates[dates.length - 1]!,
    weeks: full.length,
    latest_week: recent ? { week: recent.week, head: recent.animals.size, median_kg: recentKg } : null,
    suggestions,
  };
}

/**
 * Brings the weights in: animals the app hasn't met are created and put in
 * the chosen mob from their first day on the unit; every day's weight goes on
 * its animal; and each week with enough animals over the unit sets the mob's
 * average weight (the median of the animals weighed that week), recorded as an
 * Optiweigh weighing with how many it rests on. One batch: one Undo.
 */
export function commitOptiweigh(rows: OptiweighRow[], opts: { mob_id: number | null; filename: string }, username: string | null) {
  if (opts.mob_id !== null && !db.prepare("SELECT 1 FROM mobs WHERE id = ?").get(opts.mob_id)) throw new StockError("No such mob");
  const batch = randomUUID();
  const now = Date.now();
  const source = "optiweigh";
  return db.transaction(() => {
    const byEid = new Map<string, OptiweighRow[]>();
    for (const r of rows) byEid.set(r.eid, [...(byEid.get(r.eid) ?? []), r]);
    let created = 0, weighed = 0;
    for (const [eid, listRaw] of byEid) {
      const list = [...listRaw].sort((a, b) => a.date.localeCompare(b.date));
      let a = db.prepare("SELECT * FROM animals WHERE eid = ?").get(eid) as AnimalRow | undefined;
      if (!a) {
        const id = Number(db.prepare(`
          INSERT INTO animals (eid, tag, nlis, data, source, batch, created_at, updated_at)
          VALUES (?, ?, NULL, '{}', ?, ?, ?, ?)
        `).run(eid, list.find((r) => r.vid)?.vid ?? null, source, batch, now, now).lastInsertRowid);
        a = db.prepare("SELECT * FROM animals WHERE id = ?").get(id) as AnimalRow;
        created++;
        if (opts.mob_id !== null) addAnimalEvent(a.id, { date: list[0]!.date, kind: "join", mob_id: opts.mob_id }, source, username, batch);
      }
      for (const r of list) {
        if (db.prepare("SELECT 1 FROM animal_events WHERE animal_id = ? AND kind = 'weigh' AND date = ? AND weight_kg = ?").get(a.id, r.date, r.kg)) continue;
        addAnimalEvent(a.id, { date: r.date, kind: "weigh", weight_kg: r.kg, data: { device: "optiweigh" } }, source, username, batch);
        weighed++;
      }
    }

    let mobWeights = 0;
    if (opts.mob_id !== null) {
      const first = (db.prepare("SELECT MIN(date) d FROM mob_events WHERE mob_id = ?").get(opts.mob_id) as { d: string | null }).d;
      const weeks = weeksOf(rows);
      for (const w of weeks) {
        if (w.animals.size < MIN_WEEK_HEAD || (first && w.last < first)) continue;
        const dup = db.prepare(
          "SELECT 1 FROM mob_events WHERE mob_id = ? AND kind = 'weigh' AND date = ? AND json_extract(data, '$.method') = 'optiweigh'"
        ).get(opts.mob_id, w.last);
        if (dup) continue;
        const kg = Math.round(median([...w.animals.values()].map(median)) * 10) / 10;
        const e: EventInput = {
          date: w.last, kind: "weigh", weight_kg: kg, adg_kg: pairedGain(w, weeks),
          data: { method: "optiweigh", head_weighed: w.animals.size, note: `Optiweigh: median of the ${w.animals.size} animals over the unit that week` },
        };
        addEvent(opts.mob_id, e, "app", username, batch);
        mobWeights++;
      }
    }
    return { batch, created, weighed, mob_weights: mobWeights, animals: byEid.size };
  })();
}

/**
 * Every animal on hand in one mob moves to another on a date: a mob merged
 * into another takes its animal records with it. Part of the caller's batch.
 */
export function moveAnimalsToMob(fromMob: number, toMob: number, date: string, username: string | null, batch: string): number {
  let moved = 0;
  for (const a of animalsInMob(fromMob)) {
    if (a.status !== "alive") continue;
    addAnimalEvent(a.id, { date, kind: "leave", mob_id: fromMob }, "app", username, batch);
    addAnimalEvent(a.id, { date, kind: "join", mob_id: toMob }, "app", username, batch);
    moved++;
  }
  return moved;
}

/* ----------------------------- Optiweigh: API ----------------------------- */

/** One animal's weight for one day, as Optiweigh's API gives it. */
export interface OptiweighApiRecord { date: string; eid: string; visId: string | null; kg: number; sessionId: number }

export interface OptiweighSessionUse { mob_id: number | null; record_only: boolean }

/**
 * One day's weights from the API. A session assigned to a mob brings its
 * animals into that mob (only those in no mob yet — an animal already in
 * another mob is never moved by the unit); a record-only session just keeps
 * the weights on each animal. Sessions that are neither are held.
 * The latest days are fetched again on the next run, so a day's figure
 * already recorded is brought up to date rather than doubled.
 */
export function recordOptiweighDay(
  recs: OptiweighApiRecord[], sessions: Map<number, OptiweighSessionUse>, username: string | null, batch: string,
): { created: number; weighed: number; updated: number; held: number; mobDates: Map<number, Set<string>> } {
  let created = 0, weighed = 0, updated = 0, held = 0;
  const mobDates = new Map<number, Set<string>>();
  const now = Date.now();
  db.transaction(() => {
    for (const r of recs) {
      const use = sessions.get(r.sessionId);
      if (!use || (use.mob_id === null && !use.record_only)) { held++; continue; }
      const eid = r.eid.replace(/\D/g, "");
      if (eid.length < 10 || !(r.kg > 0 && r.kg < 1500)) continue;
      let a = db.prepare("SELECT * FROM animals WHERE eid = ?").get(eid) as AnimalRow | undefined;
      if (!a) {
        const id = Number(db.prepare(`
          INSERT INTO animals (eid, tag, nlis, data, source, batch, created_at, updated_at)
          VALUES (?, ?, NULL, '{}', 'optiweigh', ?, ?, ?)
        `).run(eid, r.visId || null, batch, now, now).lastInsertRowid);
        a = db.prepare("SELECT * FROM animals WHERE id = ?").get(id) as AnimalRow;
        created++;
      }
      if (use.mob_id !== null && currentMob(eventsOf(a.id)) === null) {
        addAnimalEvent(a.id, { date: r.date, kind: "join", mob_id: use.mob_id, data: { optiweigh_session: r.sessionId } }, "optiweigh", username, batch);
      }
      const kg = Math.round(r.kg * 10) / 10;
      const had = db.prepare(
        "SELECT id, weight_kg FROM animal_events WHERE animal_id = ? AND kind = 'weigh' AND date = ? AND source = 'optiweigh'"
      ).get(a.id, r.date) as { id: number; weight_kg: number } | undefined;
      if (had) {
        if (had.weight_kg !== kg) { db.prepare("UPDATE animal_events SET weight_kg = ? WHERE id = ?").run(kg, had.id); updated++; }
      } else {
        addAnimalEvent(a.id, { date: r.date, kind: "weigh", weight_kg: kg, data: { device: "optiweigh", session: r.sessionId, ...(use.record_only ? { record_only: true } : {}) } }, "optiweigh", username, batch);
        weighed++;
      }
      if (use.mob_id !== null) {
        const set = mobDates.get(use.mob_id) ?? new Set<string>();
        set.add(r.date);
        mobDates.set(use.mob_id, set);
      }
    }
  })();
  return { created, weighed, updated, held, mobDates };
}

/**
 * Re-works the mob's weekly Optiweigh weight for each week these dates fall
 * in, from every Optiweigh weight of the animals now in the mob: the median of
 * each animal's weights that week, with gain from the same animals three to
 * six weeks before. Replaces that week's earlier Optiweigh figure, so a week
 * filling up day by day keeps one weighing, not seven.
 */
export function refreshOptiweighWeeks(mobId: number, dates: Iterable<string>, username: string | null, batch: string): number {
  const ids = animalsInMob(mobId).filter((a) => a.status === "alive").map((a) => a.id);
  if (!ids.length) return 0;
  const first = (db.prepare("SELECT MIN(date) d FROM mob_events WHERE mob_id = ?").get(mobId) as { d: string | null }).d;
  const shift = (d: string, n: number) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  const weekData = (start: string) => {
    const rows = db.prepare(`
      SELECT animal_id, date, weight_kg FROM animal_events
      WHERE kind = 'weigh' AND source = 'optiweigh' AND date BETWEEN ? AND ?
        AND json_extract(data, '$.record_only') IS NOT 1
        AND animal_id IN (${ids.map(() => "?").join(",")})
    `).all(start, shift(start, 6), ...ids) as Array<{ animal_id: number; date: string; weight_kg: number }>;
    const animals = new Map<string, number[]>();
    let last = start;
    for (const r of rows) {
      animals.set(String(r.animal_id), [...(animals.get(String(r.animal_id)) ?? []), r.weight_kg]);
      if (r.date > last) last = r.date;
    }
    return { week: start, last, animals };
  };
  let written = 0;
  for (const wk of new Set([...dates].map(weekOf))) {
    const w = weekData(wk);
    if (w.animals.size < MIN_WEEK_HEAD || (first && w.last < first)) continue;
    const earlier = [3, 4, 5, 6].map((n) => weekData(shift(wk, -7 * n)));
    const kg = Math.round(median([...w.animals.values()].map(median)) * 10) / 10;
    db.transaction(() => {
      db.prepare(`
        DELETE FROM mob_events WHERE mob_id = ? AND kind = 'weigh' AND date BETWEEN ? AND ?
          AND json_extract(data, '$.method') = 'optiweigh'
      `).run(mobId, wk, shift(wk, 6));
      addEvent(mobId, {
        date: w.last, kind: "weigh", weight_kg: kg, adg_kg: pairedGain(w, earlier),
        data: { method: "optiweigh", head_weighed: w.animals.size, note: `Optiweigh: median of the ${w.animals.size} animals over the unit that week` },
      }, "app", username, batch);
    })();
    written++;
  }
  return written;
}

/** "HH:MM" one minute on, for ordering a record just after another the same day. */
function bump(t: string): string {
  const [h, m] = t.split(":").map(Number) as [number, number];
  const n = Math.min(23 * 60 + 59, h * 60 + m + 1);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/* ------------------------- mob weight from animals ------------------------ */

/** Fewer animals than this (or than 10% of the mob) don't set the mob's weight. */
const MIN_ANIMALS_FOR_MOB = 10;

/**
 * Keeps a mob's weight on its latest real weights. Where the mob's animals
 * have been weighed (scales sessions, a single weighing) more recently than
 * the mob's own weight, their average — those weighed within a fortnight of
 * the newest — becomes the mob's weight, recorded with how many it rests on.
 * AE, stocking rates and the pasture model all follow the mob's weight.
 *
 * Optiweigh's daily weights are left out: Optiweigh sets the mob's weight
 * itself, weekly, from a fair sample (refreshOptiweighWeeks).
 */
export function reconcileMobWeight(mobId: number, username: string | null, batch: string | null = null): { weight_kg: number; animals: number } | null {
  const view = mobViews().find((v) => v.mob.id === mobId);
  if (!view || view.state.head < 1) return null;
  const ids = animalsInMob(mobId).filter((a) => a.status === "alive").map((a) => a.id);
  if (!ids.length) return null;
  const latest = db.prepare(`
    SELECT animal_id, MAX(date) AS date FROM animal_events
    WHERE kind = 'weigh' AND weight_kg IS NOT NULL AND source != 'optiweigh'
      AND animal_id IN (${ids.map(() => "?").join(",")})
    GROUP BY animal_id
  `).all(...ids) as Array<{ animal_id: number; date: string }>;
  if (!latest.length) return null;
  const newest = latest.map((r) => r.date).sort().pop()!;
  const cutoff = new Date(Date.parse(`${newest}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
  const kgs: number[] = [];
  for (const r of latest) {
    if (r.date < cutoff) continue;
    const w = db.prepare(`
      SELECT weight_kg FROM animal_events WHERE animal_id = ? AND kind = 'weigh' AND date = ? AND weight_kg IS NOT NULL AND source != 'optiweigh'
      ORDER BY id DESC LIMIT 1
    `).get(r.animal_id, r.date) as { weight_kg: number } | undefined;
    if (w) kgs.push(w.weight_kg);
  }
  const need = Math.min(view.state.head, Math.max(MIN_ANIMALS_FOR_MOB, Math.ceil(view.state.head * 0.1)));
  if (kgs.length < need) return null;
  const kg = Math.round((kgs.reduce((t, x) => t + x, 0) / kgs.length) * 10) / 10;

  // The mob's current weighing: newer than the animals', or already this figure, and it stands.
  const cur = db.prepare(`
    SELECT date, time, weight_kg FROM mob_events WHERE mob_id = ? AND kind = 'weigh' AND weight_kg IS NOT NULL
    ORDER BY date DESC, (time IS NULL), time DESC, id DESC LIMIT 1
  `).get(mobId) as { date: string; time: string | null; weight_kg: number } | undefined;
  if (cur && (cur.date > newest || (cur.date === newest && Math.abs(cur.weight_kg - kg) < 1))) return null;

  const sameDay = db.prepare("SELECT MAX(time) t FROM mob_events WHERE mob_id = ? AND date = ?").get(mobId, newest) as { t: string | null };
  addEvent(mobId, {
    date: newest, time: sameDay.t ? bump(sameDay.t) : null, kind: "weigh", weight_kg: kg,
    data: { method: "scales", head_weighed: kgs.length, from_animals: true, note: `From the latest weights of ${kgs.length} animals in the mob` },
  }, "app", username, batch);
  return { weight_kg: kg, animals: kgs.length };
}

/** Every mob, once: brings any mob whose animals were weighed after it up to date. */
export function reconcileAllMobWeights(username: string | null): number {
  let n = 0;
  for (const v of mobViews()) if (reconcileMobWeight(v.mob.id, username)) n++;
  return n;
}

/* ------------------------ drafting by EID or tag list ---------------------- */

/**
 * A pasted list of EIDs and/or visual tags, one per line or separated by
 * commas, semicolons or tabs. An EID may be written with spaces
 * ("982 123799000987"); a line of letters and numbers separated by spaces is
 * taken as several tags.
 */
export function parseIdentifiers(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(/[\n\r,;\t]+/)) {
    const p = piece.trim();
    if (!p) continue;
    if (/^[\d\s]+$/.test(p)) {
      const digits = p.replace(/\s/g, "");
      if (digits.length >= 15 && digits.length <= 16) { out.push(digits); continue; }
      out.push(...p.split(/\s+/));
      continue;
    }
    out.push(...p.split(/\s+/));
  }
  return [...new Set(out.filter(Boolean))];
}

export interface AnimalMatch {
  matched: Array<{ id: number; tag: string | null; eid: string | null; last_weight_kg: number | null; last_weighed: string | null; token: string }>;
  /** In the app, but not in this mob now. */
  elsewhere: Array<{ token: string; tag: string | null; mob: string | null; status: string }>;
  /** A short tag ending that fits more than one animal in the mob. */
  ambiguous: string[];
  not_found: string[];
}

/**
 * Which animals in this mob a pasted list means. EIDs match exactly; tags
 * match exactly (ignoring case), or by their ending when that fits exactly
 * one animal in the mob — "3610" finds QIBH01313610.
 */
export function matchAnimalsInMob(mobId: number, text: string): AnimalMatch {
  const inMob = animalsInMob(mobId).filter((a) => a.status === "alive");
  const tokens = parseIdentifiers(text);
  const res: AnimalMatch = { matched: [], elsewhere: [], ambiguous: [], not_found: [] };
  const seen = new Set<number>();
  const mobName = (id: number | null) => (id === null ? null : (db.prepare("SELECT name FROM mobs WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? null);
  for (const token of tokens) {
    const digits = token.replace(/\D/g, "");
    const isEid = digits.length >= 15 && digits === token;
    let hits = isEid
      ? inMob.filter((a) => a.eid === digits)
      : inMob.filter((a) => (a.tag ?? "").toLowerCase() === token.toLowerCase());
    if (!hits.length && !isEid && token.length >= 3) {
      hits = inMob.filter((a) => (a.tag ?? "").toLowerCase().endsWith(token.toLowerCase()) || (a.eid ?? "").endsWith(digits.length >= 3 ? digits : "\u0000"));
      if (hits.length > 1) { res.ambiguous.push(token); continue; }
    }
    if (hits.length === 1) {
      const a = hits[0]!;
      if (!seen.has(a.id)) {
        seen.add(a.id);
        res.matched.push({ id: a.id, tag: a.tag, eid: a.eid, last_weight_kg: a.last_weight_kg, last_weighed: a.last_weighed, token });
      }
      continue;
    }
    // Not in this mob: is it anywhere?
    const any = (isEid
      ? db.prepare("SELECT * FROM animals WHERE eid = ?").get(digits)
      : db.prepare("SELECT * FROM animals WHERE tag = ? COLLATE NOCASE").get(token)) as AnimalRow | undefined;
    if (any) {
      const ev = eventsOf(any.id);
      res.elsewhere.push({ token, tag: any.tag, mob: mobName(currentMob(ev)), status: statusOf(ev).status });
    } else {
      res.not_found.push(token);
    }
  }
  return res;
}

/** Moves these animals' records from one mob to another on a date. Part of the caller's batch. */
export function moveAnimals(ids: number[], from: number, to: number, date: string, username: string | null, batch: string): number {
  let n = 0;
  for (const id of ids) {
    if (currentMob(eventsOf(id)) !== from) continue;
    addAnimalEvent(id, { date, kind: "leave", mob_id: from }, "app", username, batch);
    addAnimalEvent(id, { date, kind: "join", mob_id: to }, "app", username, batch);
    n++;
  }
  return n;
}
