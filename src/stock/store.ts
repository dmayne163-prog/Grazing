/**
 * Mobs and what has happened to them.
 *
 * A mob's head count, location and weight are never stored as current values.
 * They are the fold of its dated events, so "where was everything on 3 March
 * last year" has the same answer as "where is everything now", just with an
 * earlier cut-off — which is what paddock rest periods, grazing days and
 * stocking-rate history all need.
 */
import { db } from "../db/database.js";

export interface MobRow {
  id: number;
  name: string;
  species: string;
  breed: string | null;
  age_class: string | null;
  sex: string | null;
  tag_colour: string | null;
  management_tag: string | null;
  origin: string | null;
  birth_date: string | null;
  description: string | null;
  owner: string | null;
  data: string;
  source: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface MobEventRow {
  id: number;
  mob_id: number;
  date: string;
  kind: string;
  head: number | null;
  head_change: number | null;
  weight_kg: number | null;
  adg_kg: number | null;
  paddock_ids: string | null;
  data: string;
  source: string;
  username: string | null;
  created_at: number;
  time: string | null;
  batch: string | null;
}

export interface MobInput {
  name: string;
  species: string;
  breed: string | null;
  age_class: string | null;
  sex: string | null;
  tag_colour: string | null;
  management_tag: string | null;
  origin: string | null;
  birth_date: string | null;
  description: string | null;
  owner: string | null;
  data: Record<string, unknown>;
}

export interface EventInput {
  date: string;
  kind: "opening" | "move" | "weigh" | "count" | "purchase" | "sale" | "death" | "transfer";
  head?: number | null;
  head_change?: number | null;
  weight_kg?: number | null;
  adg_kg?: number | null;
  paddock_ids?: number[] | null;
  data?: Record<string, unknown>;
  /** "HH:MM", local. */
  time?: string | null;
}

/* ---------------------------------- AE ----------------------------------- */

/**
 * Adult Equivalents from liveweight: one AE is a 450 kg steer at maintenance,
 * and intake scales with metabolic weight (LW^0.75), so a 270 kg yearling eats
 * about two-thirds of one and a 630 kg cow a quarter more.
 *
 * It deliberately knows nothing about pregnancy or lactation, which lift
 * intake well above this; those come in when the herd records carry them.
 */
export function aeFromWeight(kg: number | null): number | null {
  if (kg === null || !Number.isFinite(kg) || kg <= 0) return null;
  return Math.round(Math.pow(kg / 450, 0.75) * 1000) / 1000;
}

/* -------------------------------- writing -------------------------------- */

export function createMobWithEvents(
  m: MobInput, events: EventInput[], source: string, username: string | null, batch: string | null = null
): number {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO mobs (name, species, breed, age_class, sex, tag_colour, management_tag, origin,
      birth_date, description, owner, data, source, created_at, updated_at, batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.name, m.species, m.breed, m.age_class, m.sex, m.tag_colour, m.management_tag, m.origin,
    m.birth_date, m.description, m.owner, JSON.stringify(m.data), source, now, now, batch
  );
  const id = Number(r.lastInsertRowid);
  for (const e of events) addEvent(id, e, source, username, batch);
  return id;
}

/** Appends one event to a mob. */
export function addEvent(
  mobId: number, e: EventInput, source: string, username: string | null, batch: string | null = null
): number {
  return Number(db.prepare(`
    INSERT INTO mob_events (mob_id, date, time, kind, head, head_change, weight_kg, adg_kg, paddock_ids,
      data, source, username, created_at, batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mobId, e.date, e.time ?? null, e.kind, e.head ?? null, e.head_change ?? null, e.weight_kg ?? null,
    e.adg_kg ?? null, e.paddock_ids ? JSON.stringify(e.paddock_ids) : null,
    JSON.stringify(e.data ?? {}), source, username, Date.now(), batch
  ).lastInsertRowid);
}

/**
 * The order events happen in. Within a day, an opening comes first (a mob
 * cannot be moved before it exists), then by time where one was recorded,
 * then in the order they were entered.
 */
export const EVENT_ORDER = "date, CASE kind WHEN 'opening' THEN 0 ELSE 1 END, IFNULL(time, ''), id";

/* -------------------------------- reading -------------------------------- */

export function listMobs(includeClosed = false): MobRow[] {
  return db.prepare(
    `SELECT * FROM mobs ${includeClosed ? "" : "WHERE closed_at IS NULL"} ORDER BY name COLLATE NOCASE, id`
  ).all() as MobRow[];
}

/**
 * Every mob's events up to a moment. With a time, events later that same day
 * are left out — which matters when a gate is opened at 2 pm on a day the mob
 * was also moved at 9 am.
 */
function eventsUpTo(asOf: string, atTime: string | null = null): Map<number, MobEventRow[]> {
  const rows = (db.prepare(
    `SELECT * FROM mob_events WHERE date <= ? ORDER BY mob_id, ${EVENT_ORDER}`
  ).all(asOf) as MobEventRow[]).filter((e) =>
    atTime === null || e.date < asOf || e.time === null || e.time <= atTime
  );
  const out = new Map<number, MobEventRow[]>();
  for (const e of rows) {
    const list = out.get(e.mob_id);
    if (list) list.push(e);
    else out.set(e.mob_id, [e]);
  }
  return out;
}

export interface MobState {
  head: number;
  paddock_ids: number[];
  weight_kg: number | null;
  /** Last weight projected forward by the assumed daily gain. */
  est_weight_kg: number | null;
  last_weighed: string | null;
  adg_kg: number | null;
  /** Since this date the mob has been where it is now. */
  in_paddock_since: string | null;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

function fold(events: MobEventRow[], asOf: string): MobState {
  const s: MobState = {
    head: 0, paddock_ids: [], weight_kg: null, est_weight_kg: null,
    last_weighed: null, adg_kg: null, in_paddock_since: null,
  };
  for (const e of events) {
    if (e.head !== null && (e.kind === "opening" || e.kind === "count")) s.head = e.head;
    if (e.head_change !== null) s.head += e.head_change;
    if (e.paddock_ids !== null && (e.kind === "opening" || e.kind === "move")) {
      const next = JSON.parse(e.paddock_ids) as number[];
      if (e.kind === "move" || s.in_paddock_since === null) s.in_paddock_since = e.date;
      s.paddock_ids = next;
    }
    if (e.weight_kg !== null) {
      s.weight_kg = e.weight_kg;
      s.last_weighed = e.date;
      s.adg_kg = e.adg_kg;
    }
  }
  if (s.weight_kg !== null && s.last_weighed !== null) {
    const days = Math.max(0, daysBetween(s.last_weighed, asOf));
    s.est_weight_kg = Math.round((s.weight_kg + (s.adg_kg ?? 0) * days) * 10) / 10;
  }
  return s;
}

export function today(): string {
  // Local date, not UTC: at 7am in Queensland it is still yesterday in UTC.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface MobView {
  mob: MobRow;
  state: MobState;
  ae_head: number | null;
  ae_total: number | null;
  /** AgriWebb's flat, class-based figure, kept for comparison where imported. */
  agriwebb_ae_head: number | null;
}

export function mobViews(asOf = today(), atTime: string | null = null): MobView[] {
  const events = eventsUpTo(asOf, atTime);
  // Closed mobs are included so a past date shows what was there then; the
  // head filter below drops anything not on hand on that date.
  const isToday = asOf >= today();
  return listMobs(!isToday).map((mob) => {
    const state = fold(events.get(mob.id) ?? [], asOf);
    const ae = aeFromWeight(state.est_weight_kg);
    const data = JSON.parse(mob.data) as Record<string, unknown>;
    const aw = typeof data["agriwebb_ae_head"] === "number" ? data["agriwebb_ae_head"] : null;
    return {
      mob, state, ae_head: ae,
      ae_total: ae === null ? null : Math.round(ae * state.head * 10) / 10,
      agriwebb_ae_head: aw,
    };
  }).filter((v) => v.state.head > 0 || (isToday && v.mob.closed_at === null && !events.has(v.mob.id)));
}

export interface PaddockStock {
  paddock_id: number;
  head: number;
  ae: number;
  agriwebb_ae: number;
  /** AE per grazable ha, with each mob spread over every paddock it can reach. */
  ae_per_ha: number;
  agriwebb_ae_per_ha: number;
  mob_ids: number[];
}

/**
 * Stock on each paddock. A mob with gates open across several paddocks has
 * its AE spread over their combined area, and its head counted against the
 * first — the same convention AgriWebb uses, so the numbers can be checked
 * against its reports line for line.
 */
export function paddockStock(areaOf: (id: number) => number | null, asOf = today()): PaddockStock[] {
  const out = new Map<number, PaddockStock>();
  const get = (id: number) => {
    let p = out.get(id);
    if (!p) {
      p = { paddock_id: id, head: 0, ae: 0, agriwebb_ae: 0, ae_per_ha: 0, agriwebb_ae_per_ha: 0, mob_ids: [] };
      out.set(id, p);
    }
    return p;
  };
  for (const v of mobViews(asOf)) {
    const ids = v.state.paddock_ids;
    if (ids.length === 0 || v.state.head <= 0) continue;
    const area = ids.reduce((s, id) => s + (areaOf(id) ?? 0), 0);
    const ae = v.ae_total ?? 0;
    const aw = (v.agriwebb_ae_head ?? 0) * v.state.head;
    ids.forEach((id, i) => {
      const p = get(id);
      if (i === 0) {
        p.head += v.state.head;
        p.ae += ae;
        p.agriwebb_ae += aw;
      }
      p.mob_ids.push(v.mob.id);
      if (area > 0) {
        p.ae_per_ha += ae / area;
        p.agriwebb_ae_per_ha += aw / area;
      }
    });
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return [...out.values()].map((p) => ({
    ...p, ae: r3(p.ae), agriwebb_ae: r3(p.agriwebb_ae),
    ae_per_ha: r3(p.ae_per_ha), agriwebb_ae_per_ha: r3(p.agriwebb_ae_per_ha),
  }));
}

/* -------------------------------- editing -------------------------------- */

export interface MobEdit {
  name?: string;
  owner?: string | null;
  sex?: string | null;
  description?: string | null;
}

/**
 * Corrects what a mob *is*. Where it is and how many are events and change
 * through moves and counts, never by editing the mob.
 */
export function updateMob(id: number, edit: MobEdit): MobRow | null {
  const cur = db.prepare("SELECT * FROM mobs WHERE id = ?").get(id) as MobRow | undefined;
  if (!cur) return null;
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;
  const name = edit.name !== undefined ? text(edit.name, 120) ?? cur.name : cur.name;
  const owner = edit.owner !== undefined ? text(edit.owner, 120) : cur.owner;
  const sex = edit.sex !== undefined
    ? (["female", "male", "steer"].includes(String(edit.sex)) ? String(edit.sex) : null)
    : cur.sex;
  const description = edit.description !== undefined ? text(edit.description, 2000) : cur.description;
  db.prepare(
    "UPDATE mobs SET name = ?, owner = ?, sex = ?, description = ?, updated_at = ? WHERE id = ?"
  ).run(name, owner, sex, description, Date.now(), id);
  return db.prepare("SELECT * FROM mobs WHERE id = ?").get(id) as MobRow;
}

/* ----------------------------- grazing history --------------------------- */

export interface Segment {
  mob_id: number;
  from: string;
  /** Exclusive: the date the mob's position or head next changed. Null while current. */
  to: string | null;
  head: number;
  paddock_ids: number[];
}

/**
 * Every mob's life as a run of steady states — same paddocks, same head —
 * each with the date it began and ended. Several events on one day are taken
 * together, so a mob drafted and moved in a morning is one change, not three.
 */
export function allSegments(): Segment[] {
  const rows = db.prepare(
    `SELECT * FROM mob_events ORDER BY mob_id, ${EVENT_ORDER}`
  ).all() as MobEventRow[];
  const out: Segment[] = [];
  let i = 0;
  while (i < rows.length) {
    const mobId = rows[i]!.mob_id;
    let head = 0;
    let paddocks: number[] = [];
    let open: Segment | null = null;
    while (i < rows.length && rows[i]!.mob_id === mobId) {
      const date = rows[i]!.date;
      while (i < rows.length && rows[i]!.mob_id === mobId && rows[i]!.date === date) {
        const e = rows[i]!;
        if (e.head !== null && (e.kind === "opening" || e.kind === "count")) head = e.head;
        if (e.head_change !== null) head += e.head_change;
        if (e.paddock_ids !== null && (e.kind === "opening" || e.kind === "move")) {
          paddocks = JSON.parse(e.paddock_ids) as number[];
        }
        i++;
      }
      const same = open && open.head === head && open.paddock_ids.join(",") === paddocks.join(",");
      if (same) continue;
      if (open) { open.to = date; out.push(open); open = null; }
      if (head > 0 && paddocks.length) open = { mob_id: mobId, from: date, to: null, head, paddock_ids: paddocks };
    }
    if (open) out.push(open);
  }
  return out;
}

export function recordsBegin(): string | null {
  return (db.prepare("SELECT MIN(date) d FROM mob_events").get() as { d: string | null }).d;
}

export interface GrazingPeriod {
  mob_id: number;
  mob_name: string;
  owner: string | null;
  from: string;
  to: string | null;
  days: number;
  head_start: number;
  head_end: number;
  head_days: number;
  /** Other paddocks the mob could reach at the same time (gates open). */
  shared_with: number[];
}

export interface PaddockHistory {
  paddock_id: number;
  periods: GrazingPeriod[];
  rests: Array<{ from: string; to: string | null; days: number }>;
  occupied: boolean;
  last_grazed: string | null;
  rest_days: number | null;
  grazing_days_365: number;
  head_days_365: number;
}

/** Grazing periods and rests for every paddock that has any history. */
export function paddockHistories(): Map<number, PaddockHistory> {
  const now = today();
  const begin = recordsBegin();
  const mobs = new Map((db.prepare("SELECT id, name, owner FROM mobs").all() as Array<{ id: number; name: string; owner: string | null }>)
    .map((m) => [m.id, m]));
  const yearAgo = new Date(Date.parse(`${now}T00:00:00Z`) - 365 * DAY_MS).toISOString().slice(0, 10);

  const byPaddock = new Map<number, GrazingPeriod[]>();
  for (const s of allSegments()) {
    for (const pid of s.paddock_ids) {
      const list = byPaddock.get(pid) ?? [];
      const prev = list[list.length - 1];
      const days = daysBetween(s.from, s.to ?? now);
      // Consecutive stretches of one mob in one paddock are one grazing period,
      // even if its head changed or gates opened part way through.
      if (prev && prev.mob_id === s.mob_id && prev.to === s.from) {
        prev.to = s.to;
        prev.days += days;
        prev.head_end = s.head;
        prev.head_days += s.head * days;
        prev.shared_with = [...new Set([...prev.shared_with, ...s.paddock_ids.filter((p) => p !== pid)])];
      } else {
        const m = mobs.get(s.mob_id);
        list.push({
          mob_id: s.mob_id, mob_name: m?.name ?? `#${s.mob_id}`, owner: m?.owner ?? null,
          from: s.from, to: s.to, days, head_start: s.head, head_end: s.head, head_days: s.head * days,
          shared_with: s.paddock_ids.filter((p) => p !== pid),
        });
      }
      byPaddock.set(pid, list);
    }
  }

  const out = new Map<number, PaddockHistory>();
  for (const [pid, periods] of byPaddock) {
    periods.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    // Occupied stretches, merged where mobs overlapped; the gaps are rests.
    const spans: Array<[string, string | null]> = [];
    for (const p of periods) {
      const last = spans[spans.length - 1];
      if (last && (last[1] === null || p.from <= last[1])) {
        if (last[1] !== null && (p.to === null || p.to > last[1])) last[1] = p.to;
      } else {
        spans.push([p.from, p.to]);
      }
    }
    const rests: PaddockHistory["rests"] = [];
    if (begin && spans[0] && spans[0][0] > begin) rests.push({ from: begin, to: spans[0][0], days: daysBetween(begin, spans[0][0]) });
    for (let k = 1; k < spans.length; k++) {
      const a = spans[k - 1]![1]!, b = spans[k]![0];
      if (b > a) rests.push({ from: a, to: b, days: daysBetween(a, b) });
    }
    const lastSpan = spans[spans.length - 1];
    const occupied = !!lastSpan && lastSpan[1] === null;
    if (lastSpan && lastSpan[1] !== null) rests.push({ from: lastSpan[1], to: null, days: daysBetween(lastSpan[1], now) });

    // Grazing days count the paddock, not the mobs: two mobs in together for
    // a week is seven grazing days (and twice the head-days), not fourteen.
    let gd = 0, hd = 0;
    for (const [a, b] of spans) {
      const from = a > yearAgo ? a : yearAgo;
      const to = b ?? now;
      if (to > from) gd += daysBetween(from, to);
    }
    for (const p of periods) {
      const from = p.from > yearAgo ? p.from : yearAgo;
      const to = p.to ?? now;
      if (to <= from) continue;
      hd += daysBetween(from, to) * (p.head_start + p.head_end) / 2;
    }
    out.set(pid, {
      paddock_id: pid,
      periods: periods.reverse(),
      rests: rests.reverse(),
      occupied,
      last_grazed: occupied ? now : lastSpan?.[1] ?? null,
      rest_days: occupied ? 0 : lastSpan?.[1] ? daysBetween(lastSpan[1], now) : null,
      grazing_days_365: gd,
      head_days_365: Math.round(hd),
    });
  }
  return out;
}
