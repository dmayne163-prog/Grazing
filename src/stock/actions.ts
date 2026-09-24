/**
 * The things done to mobs from the map and the mob page: moving, drafting
 * some off, opening and closing gates — and undoing any of them.
 *
 * Each action writes all of its events under one batch id. A draft is an
 * event on the parent, a new mob and its opening; a gate opening is the gate
 * event plus a move for every mob that gained access. Undo removes the batch,
 * so it can never leave half an action behind.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { getFeature, listFeatures } from "../map/store.js";
import { gateInfo, gateStateAt, isGate } from "../map/gates.js";
import { addEvent, createMobWithEvents, mobViews, today, type MobRow, type MobView } from "./store.js";

export class StockError extends Error {}

export interface When {
  date: string;
  time: string | null;
}

function nowLocal(): When {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: today(), time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** Checks a date and optional time, and that they are not in the future. */
export function parseWhen(date: unknown, time: unknown): When {
  if (date === undefined || date === null || date === "") return nowLocal();
  const d = String(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new StockError("Give the date as YYYY-MM-DD");
  let t: string | null = null;
  if (time !== undefined && time !== null && time !== "") {
    t = String(time);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new StockError("Give the time as HH:MM");
  }
  // A few minutes' grace for a phone clock slightly ahead of the server's.
  const limit = new Date(Date.now() + 5 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const limitStr = `${limit.getFullYear()}-${p(limit.getMonth() + 1)}-${p(limit.getDate())} ${p(limit.getHours())}:${p(limit.getMinutes())}`;
  if (`${d} ${t ?? "00:00"}` > limitStr) throw new StockError("That is in the future");
  return { date: d, time: t };
}

function paddockIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) throw new StockError("Choose at least one paddock");
  const out = [...new Set(ids.map(Number))];
  if (out.length === 0) throw new StockError("Choose at least one paddock");
  for (const id of out) {
    const f = Number.isInteger(id) ? getFeature(id) : null;
    if (!f || f.kind !== "paddock" || f.deleted_at !== null) throw new StockError("One of those paddocks is not on the map");
  }
  return out;
}

function mobAt(id: number, when: When): MobView {
  const v = mobViews(when.date, when.time).find((x) => x.mob.id === id);
  if (!v) throw new StockError("That mob had no head on that date — it may not have existed yet, or was already sold");
  return v;
}

const clean = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/* ---------------------------------- move --------------------------------- */

/**
 * Moves one or more mobs to a paddock, or a set of paddocks with gates open
 * between them. The first paddock is where their head is counted.
 */
export function moveMobs(
  mobIds: number[], to: unknown, when: When, note: string | null, username: string | null
): string {
  const dest = paddockIds(to);
  if (mobIds.length === 0) throw new StockError("Choose a mob to move");
  const batch = randomUUID();
  db.transaction(() => {
    for (const id of new Set(mobIds)) {
      mobAt(id, when);
      addEvent(id, { date: when.date, time: when.time, kind: "move", paddock_ids: dest, data: note ? { note } : {} },
        "app", username, batch);
    }
  })();
  return batch;
}

/* ---------------------------------- draft -------------------------------- */

export interface DraftInput {
  head: unknown;
  to: unknown;
  name?: unknown;
  sex?: unknown;
  note?: unknown;
  weight_kg?: unknown;
}

/**
 * Drafts some of a mob off into a new mob somewhere else. The new mob takes
 * the parent's breed, class, tag, owner and so on; its weight is the one
 * given, or the parent's where none was.
 */
export function draftMob(mobId: number, input: DraftInput, when: When, username: string | null): { batch: string; mob_id: number } {
  const parent = mobAt(mobId, when);
  const head = Number(input.head);
  if (!Number.isInteger(head) || head < 1) throw new StockError("Enter how many head were drafted off");
  if (head >= parent.state.head) {
    throw new StockError(`That is the whole mob (${parent.state.head} hd) — move the mob instead`);
  }
  const dest = paddockIds(input.to);
  const weight = input.weight_kg === undefined || input.weight_kg === null || input.weight_kg === ""
    ? null : Number(input.weight_kg);
  if (weight !== null && (!Number.isFinite(weight) || weight <= 0 || weight > 1500)) {
    throw new StockError("Weight must be in kg, between 1 and 1500");
  }
  const sex = ["female", "male", "steer"].includes(String(input.sex)) ? String(input.sex) : parent.mob.sex;
  const note = clean(input.note, 500);
  const p: MobRow = parent.mob;
  const batch = randomUUID();

  const newId = db.transaction(() => {
    const id = createMobWithEvents({
      name: clean(input.name, 120) ?? `${p.name} (draft)`,
      species: p.species, breed: p.breed, age_class: p.age_class, sex,
      tag_colour: p.tag_colour, management_tag: p.management_tag, origin: p.origin,
      birth_date: p.birth_date, description: note, owner: p.owner,
      data: { drafted_from: p.id },
    }, [
      { date: when.date, time: when.time, kind: "opening", head, paddock_ids: dest,
        data: { from_mob: p.id, how: "draft", ...(note ? { note } : {}) } },
      ...(weight !== null || parent.state.est_weight_kg !== null ? [{
        date: when.date, time: when.time, kind: "weigh" as const,
        weight_kg: weight ?? parent.state.est_weight_kg, adg_kg: weight === null ? parent.state.adg_kg : null,
        data: weight === null ? { inherited_from: p.id, note: "Weight carried over from the mob it was drafted from" } : {},
      }] : []),
    ], "app", username, batch);
    addEvent(p.id, {
      date: when.date, time: when.time, kind: "transfer", head_change: -head,
      data: { to_mob: id, to_paddocks: dest, ...(note ? { note } : {}) },
    }, "app", username, batch);
    return id;
  })();
  return { batch, mob_id: newId };
}

/* ---------------------------------- gates -------------------------------- */

export interface GateChange {
  mob_id: number;
  mob_name: string;
  head: number;
  from: number[];
  to: number[];
}

export interface GateInput {
  state: unknown;
  paddocks?: unknown;
  /** For closing: which paddock each mob with access to both ends up in. */
  sides?: unknown;
  note?: unknown;
}

/**
 * Opens or closes a gate at a moment, and works out what that does to the
 * mobs either side. With dryRun nothing is written — the panel uses that to
 * show "these three mobs will be able to reach No.8" before the button.
 */
export function setGate(
  gateId: number, input: GateInput, when: When, username: string | null, dryRun = false
): { batch: string | null; paddocks: number[]; changes: GateChange[] } {
  const gate = getFeature(gateId);
  if (!gate || gate.deleted_at !== null || !isGate(gate)) throw new StockError("That is not a gate");
  const state = input.state === "open" ? "open" : input.state === "closed" ? "closed" : null;
  if (!state) throw new StockError("Say whether the gate is being opened or closed");

  const pair = input.paddocks !== undefined && input.paddocks !== null
    ? paddockIds(input.paddocks)
    : gateInfo(gate, listFeatures().filter((f) => f.kind === "paddock"), null).paddocks;
  if (pair.length !== 2 || pair[0] === pair[1]) {
    throw new StockError("This gate needs two paddocks either side of it — set them in the gate panel");
  }
  const [a, b] = pair as [number, number];

  const current = gateStateAt(gateId, when.date, when.time);
  if ((current?.state ?? "closed") === state) {
    throw new StockError(`The gate is already ${state} at that time`);
  }

  const sides = (input.sides ?? {}) as Record<string, unknown>;
  const changes: GateChange[] = [];
  for (const v of mobViews(when.date, when.time)) {
    const set = v.state.paddock_ids;
    const hasA = set.includes(a), hasB = set.includes(b);
    let next: number[] | null = null;
    if (state === "open" && hasA !== hasB) {
      next = [...set, hasA ? b : a];
    } else if (state === "closed" && hasA && hasB) {
      // Which side they end up on: as told, else wherever their head is counted.
      const told = Number(sides[String(v.mob.id)]);
      const home = told === a || told === b ? told : set[0] === b ? b : a;
      const other = home === a ? b : a;
      next = set.filter((p) => p !== other);
      if (!next.includes(home)) next.unshift(home);
    }
    if (next) changes.push({ mob_id: v.mob.id, mob_name: v.mob.name, head: v.state.head, from: set, to: next });
  }
  if (dryRun) return { batch: null, paddocks: pair, changes };

  const note = clean(input.note, 300);
  const batch = randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO gate_events (gate_id, paddock_a, paddock_b, state, date, time, note, batch, username, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(gateId, a, b, state, when.date, when.time, note, batch, username, Date.now());
    for (const c of changes) {
      addEvent(c.mob_id, {
        date: when.date, time: when.time, kind: "move", paddock_ids: c.to,
        data: { gate: gateId, gate_name: gate.name, reason: state === "open" ? "gate opened" : "gate closed" },
      }, "app", username, batch);
    }
  })();
  return { batch, paddocks: pair, changes };
}

/* ---------------------------------- undo --------------------------------- */

/**
 * Removes everything one action recorded. A mob the action created goes too —
 * unless something has been recorded against it since, in which case that has
 * to be undone first, or the undo would throw away records it never made.
 */
export function undoBatch(batch: string): { events: number; mobs: number; gates: number; animals: number; sessions: number } {
  if (!/^[0-9a-f-]{36}$/.test(batch)) throw new StockError("Nothing to undo");
  return db.transaction(() => {
    const created = db.prepare("SELECT id, name FROM mobs WHERE batch = ?").all(batch) as Array<{ id: number; name: string }>;
    for (const m of created) {
      const later = db.prepare("SELECT COUNT(*) n FROM mob_events WHERE mob_id = ? AND IFNULL(batch, '') != ?")
        .get(m.id, batch) as { n: number };
      if (later.n > 0) {
        throw new StockError(`${m.name} has had other things recorded since; undo those first`);
      }
    }
    // The same rule for animals a session created.
    const newAnimals = db.prepare("SELECT id, tag, eid FROM animals WHERE batch = ?").all(batch) as Array<{ id: number; tag: string | null; eid: string | null }>;
    for (const a of newAnimals) {
      const later = db.prepare("SELECT COUNT(*) n FROM animal_events WHERE animal_id = ? AND IFNULL(batch, '') != ?")
        .get(a.id, batch) as { n: number };
      if (later.n > 0) {
        throw new StockError(`Animal ${a.tag ?? a.eid} has had other things recorded since; undo those first`);
      }
    }
    const events = db.prepare("DELETE FROM mob_events WHERE batch = ?").run(batch).changes;
    const gates = db.prepare("DELETE FROM gate_events WHERE batch = ?").run(batch).changes;
    const mobs = db.prepare("DELETE FROM mobs WHERE batch = ?").run(batch).changes;
    const animalEvents = db.prepare("DELETE FROM animal_events WHERE batch = ?").run(batch).changes;
    const animals = db.prepare("DELETE FROM animals WHERE batch = ?").run(batch).changes;
    const sessions = db.prepare("DELETE FROM weigh_sessions WHERE batch = ?").run(batch).changes;
    if (events + gates + mobs + animalEvents + animals + sessions === 0) {
      throw new StockError("Nothing to undo — it may already have been undone");
    }
    return { events: events + animalEvents, mobs, gates, animals, sessions };
  })();
}

/**
 * Deletes a single event recorded in the app before batches existed. Imported
 * records are not deletable here: they came from AgriWebb and are the record
 * of what happened.
 */
export function deleteAppEvent(id: number): void {
  const e = db.prepare("SELECT source, batch FROM mob_events WHERE id = ?").get(id) as { source: string; batch: string | null } | undefined;
  if (!e) throw new StockError("No such record");
  if (e.batch) { undoBatch(e.batch); return; }
  if (e.source !== "app") throw new StockError("Imported records can't be deleted here");
  db.prepare("DELETE FROM mob_events WHERE id = ?").run(id);
}

/* ---------------------------------- weigh -------------------------------- */

export interface WeighInput {
  weight_kg: unknown;
  /** Assumed daily gain from here on, for projecting weight between weighings. */
  adg_kg?: unknown;
  /** How it was weighed: an Optiweigh average, the yard scales, or an eye estimate. */
  method?: unknown;
  /** How many head the average came from, where not the whole mob. */
  head_weighed?: unknown;
  note?: unknown;
}

const METHODS = ["optiweigh", "scales", "estimate"];

/**
 * Records a mob's average weight. That weight is what AE and stocking rates
 * are worked from until the next one, projected forward by the daily gain
 * when one is given.
 */
export function weighMob(mobId: number, input: WeighInput, when: When, username: string | null): { batch: string } {
  const v = mobAt(mobId, when);
  const kg = Number(input.weight_kg);
  if (!Number.isFinite(kg) || kg <= 0 || kg > 1500) throw new StockError("Enter the average weight in kg");
  const adg = input.adg_kg === undefined || input.adg_kg === null || input.adg_kg === "" ? null : Number(input.adg_kg);
  if (adg !== null && (!Number.isFinite(adg) || adg < -3 || adg > 3)) {
    throw new StockError("Daily gain must be between -3 and 3 kg a day");
  }
  const head = input.head_weighed === undefined || input.head_weighed === null || input.head_weighed === ""
    ? null : Number(input.head_weighed);
  if (head !== null && (!Number.isInteger(head) || head < 1 || head > v.state.head)) {
    throw new StockError(`Head weighed must be between 1 and ${v.state.head}`);
  }
  const method = METHODS.includes(String(input.method)) ? String(input.method) : null;
  const note = clean(input.note, 500);
  const batch = randomUUID();
  addEvent(mobId, {
    date: when.date, time: when.time, kind: "weigh", weight_kg: Math.round(kg * 10) / 10, adg_kg: adg,
    data: { ...(method ? { method } : {}), ...(head !== null ? { head_weighed: head } : {}), ...(note ? { note } : {}) },
  }, "app", username, batch);
  return { batch };
}

/* ------------------------------ head changes ----------------------------- */

/** Deaths in a mob: head down by that many from the moment given. */
export function recordDeaths(mobId: number, nRaw: unknown, when: When, noteRaw: unknown, username: string | null): { batch: string } {
  const v = mobAt(mobId, when);
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n < 1) throw new StockError("Enter how many died");
  if (n > v.state.head) throw new StockError(`The mob only had ${v.state.head} hd then`);
  const note = clean(noteRaw, 500);
  const batch = randomUUID();
  addEvent(mobId, { date: when.date, time: when.time, kind: "death", head_change: -n, data: note ? { note } : {} }, "app", username, batch);
  return { batch };
}

/** A count that says what the head actually is, from that moment on. */
export function recount(mobId: number, headRaw: unknown, when: When, noteRaw: unknown, username: string | null): { batch: string } {
  mobAt(mobId, when);
  const head = Number(headRaw);
  if (!Number.isInteger(head) || head < 0 || head > 100_000) throw new StockError("Enter the head counted");
  const note = clean(noteRaw, 500);
  const batch = randomUUID();
  addEvent(mobId, { date: when.date, time: when.time, kind: "count", head, data: note ? { note } : {} }, "app", username, batch);
  return { batch };
}

/**
 * Strikes out an imported record as a mistake — the AgriWebb death that never
 * happened. The record stays in the history, marked, and stops counting.
 * Records made in this app are undone instead; openings can't be struck out,
 * since without one the mob has no starting point.
 */
export function voidEvent(eventId: number, reasonRaw: unknown, username: string | null): { batch: string } {
  const e = db.prepare("SELECT id, mob_id, kind, source FROM mob_events WHERE id = ?").get(eventId) as
    { id: number; mob_id: number; kind: string; source: string } | undefined;
  if (!e) throw new StockError("No such record");
  if (e.kind === "opening" || e.kind === "void") throw new StockError("That record can't be marked as a mistake");
  if (e.source === "app") throw new StockError("Records made in this app are undone rather than marked as mistakes");
  const already = db.prepare("SELECT 1 FROM mob_events WHERE kind = 'void' AND json_extract(data, '$.voids') = ?").get(eventId);
  if (already) throw new StockError("That record is already marked as a mistake");
  const reason = clean(reasonRaw, 300);
  const batch = randomUUID();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  addEvent(e.mob_id, {
    date: today(), time: `${p(d.getHours())}:${p(d.getMinutes())}`, kind: "void",
    data: { voids: eventId, ...(reason ? { reason } : {}) },
  }, "app", username, batch);
  return { batch };
}
