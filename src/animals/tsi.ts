/**
 * A whole TSi / APS backup brought in at once: the WeighScaleCE.db that
 * Gallagher's TSi software and the TW scales keep, which holds every animal,
 * session, weight, treatment and note ever recorded on them.
 *
 * It is history, not head counts. Mob numbers are never changed by it:
 * animals already in the app (matched by EID) stay where they are and gain
 * their earlier history; the rest come in with how they left the herd where
 * TSi says, or can show it. Animals TSi still calls current but which aren't
 * in any mob here are left "not in a mob" — or put into a mob, cohort by
 * cohort, where the person importing says so.
 *
 * TSi's own "dead" is mostly not death: whole drafts were marked dead to tidy
 * the list after they were trucked out. A death with a cause written against
 * it, or one of a handful on a day, is taken as a death; the rest are recorded
 * as off the books, dated and with where they probably went.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { StockError } from "../stock/actions.js";
import { mobViews } from "../stock/store.js";

/* ------------------------------- reading --------------------------------- */

/** .NET ticks (100 ns since 0001-01-01, local wall-clock) → date and time. */
function fromTicks(t: unknown): { date: string; time: string | null } | null {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = (n - 621_355_968_000_000_000) / 10_000;
  if (ms < Date.UTC(1990, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null;
  const iso = new Date(ms).toISOString();
  const time = iso.slice(11, 16);
  return { date: iso.slice(0, 10), time: time === "00:00" ? null : time };
}

export interface TsiAnimal {
  tid: number;
  eid: string | null;
  tag: string | null;
  nlis: string | null;
  sex: string | null;
  breed: string | null;
  birth_date: string | null;
  origin: string | null;
  status: string;
  info: Record<string, string>;
}

export interface TsiSession { tid: number; name: string; date: string; head: number }

export interface TsiEvent {
  tid: number;
  sid: number | null;
  date: string;
  time: string | null;
  kind: "weigh" | "score" | "treatment" | "note";
  weight_kg?: number;
  score?: number;
  text?: string;
}

/** What TSi says happened to an animal: its life events, in order. */
interface TsiLife { kind: string; date: string; note: string }

export interface TsiBackup {
  backup_date: string;
  animals: TsiAnimal[];
  sessions: TsiSession[];
  events: TsiEvent[];
  life: Record<number, TsiLife[]>;
  /** Each animal's sessions, in order (TSi session ids). */
  seen: Record<number, number[]>;
  /** Draft flags set in each animal's sessions: "tid:sid" → ["Sending to Arcadian", …]. */
  flags: Record<string, string[]>;
  /** Cattle put through the yards for someone else, left out of everything above. */
  not_ours: NotOurs;
}

/**
 * Animals marked Purchased = No in a session (and never Yes): someone else's
 * cattle processed through these yards, as the Penjobe owners' 89 head in
 * "Purchse from penjobe" on 22 Apr 2026. They must never enter the records.
 * One already in the app by EID is kept, since something else put it there,
 * and listed so it can be checked.
 */
export interface NotOurs {
  head: number;
  sessions: Array<{ name: string; date: string; head: number }>;
  in_app: Array<{ tag: string | null; eid: string | null }>;
}

const OWN_PIC = "QHBH0156";
const SEX: Record<string, string> = { Female: "female", "Desexed F": "female", Male: "male", Stag: "male", "Desexed M": "steer", STEER: "steer" };
/** "Droughtmaster x", "Droughtmaster-X" → "Droughtmaster X". */
const breedName = (b: string) => b.trim().replace(/[-\s]+x$/i, " X") || null;
const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function isTsiBackup(buf: Buffer): boolean {
  return buf.length > 100 && buf.toString("latin1", 0, 15) === "SQLite format 3";
}

export function readTsiBackup(file: string): TsiBackup {
  const t = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const has = (n: string) => !!t.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
    if (!["Animal", "Session", "SessionAnimal", "SessionAnimalTrait", "PicklistValue"].every(has)) {
      throw new StockError("This database isn't a TSi / APS backup (WeighScaleCE.db)");
    }
    const names = new Map((t.prepare("SELECT picklistvalue_id id, value FROM PicklistValue").all() as Array<{ id: number; value: string }>)
      .map((r) => [r.id, r.value]));
    const traitName = (code: number) => names.get(code) ?? `Trait ${code}`;

    const sessions: TsiSession[] = (t.prepare(`
      SELECT s.session_id tid, s.name, s.created,
        (SELECT COUNT(*) FROM SessionAnimal a WHERE a.session_id = s.session_id AND a.is_deleted = 0) head
      FROM Session s`).all() as Array<{ tid: number; name: string | null; created: unknown; head: number }>)
      .map((s) => ({ tid: s.tid, name: clean(s.name) ?? "", date: fromTicks(s.created)?.date ?? "", head: s.head }))
      .filter((s) => s.date);

    const animals: TsiAnimal[] = (t.prepare("SELECT * FROM Animal WHERE is_deleted = 0").all() as Array<Record<string, unknown>>).map((a) => {
      const eid = String(a["rfid"] ?? "").replace(/\D/g, "");
      const pic = clean(a["prev_pic"]);
      const info: Record<string, string> = {};
      for (const [k, label] of [["colour", "colour"], ["animal_group", "group"], ["prev_pic", "original PIC"], ["prev_tag", "previous tag"],
        ["sire", "sire"], ["dam", "dam"], ["current_property", "property"]] as const) {
        const v = clean(a[k]);
        if (v) info[label] = v;
      }
      return {
        tid: Number(a["animal_id"]),
        eid: eid.length >= 10 ? eid : null,
        tag: clean(a["tag"]),
        nlis: clean(a["nlis"]),
        sex: SEX[String(a["sex"] ?? "")] ?? null,
        breed: clean(a["breed"]) ? breedName(String(a["breed"])) : null,
        birth_date: fromTicks(a["dob"])?.date ?? null,
        origin: pic && pic !== OWN_PIC ? `PIC ${pic}` : pic === OWN_PIC ? "Bred (QHBH0156)" : null,
        status: String(a["status"] ?? ""),
        info,
      };
    });

    const events: TsiEvent[] = [];
    // Weights and condition scores, one event each.
    const traits = t.prepare(`SELECT session_id sid, animal_id tid, trait_code code, alpha_value v, when_measured w
      FROM SessionAnimalTrait WHERE is_deleted = 0`).all() as Array<{ sid: number; tid: number; code: number; v: string | null; w: unknown }>;
    const acts = t.prepare(`SELECT session_id sid, animal_id tid, activity_code code, when_measured w
      FROM SessionAnimalActivity WHERE is_deleted = 0`).all() as Array<{ sid: number; tid: number; code: number; w: unknown }>;
    // Everything else done in a session — treatments, batch numbers, draft
    // flags, paddock — goes on one "processed" record per animal per session.
    const processed = new Map<string, { tid: number; sid: number; date: string; time: string | null; items: string[] }>();
    const flags: Record<string, string[]> = {};
    const put = (tid: number, sid: number, w: unknown, item: string) => {
      const when = fromTicks(w);
      if (!when) return;
      const k = `${tid}:${sid}`;
      const p = processed.get(k) ?? { tid, sid, date: when.date, time: when.time, items: [] };
      if (when.date < p.date) { p.date = when.date; p.time = when.time; }
      if (!p.items.includes(item)) p.items.push(item);
      processed.set(k, p);
    };
    for (const r of traits) {
      const when = fromTicks(r.w);
      const v = clean(r.v);
      if (!when || v === null) continue;
      const name = traitName(r.code);
      if (name === "Live Weight") {
        const kg = Number(v);
        if (Number.isFinite(kg) && kg > 0 && kg <= 1500) {
          events.push({ tid: r.tid, sid: r.sid, date: when.date, time: when.time, kind: "weigh", weight_kg: Math.round(kg * 10) / 10 });
        }
      } else if (name === "Condition Score") {
        const s = Number(v);
        if (Number.isFinite(s) && s > 0) events.push({ tid: r.tid, sid: r.sid, date: when.date, time: when.time, kind: "score", score: s });
      } else if (/^no$/i.test(v)) {
        continue;
      } else if (/^yes$/i.test(v)) {
        put(r.tid, r.sid, r.w, name);
        if (/^sending|^drafted onto|^putting on/i.test(name)) (flags[`${r.tid}:${r.sid}`] ||= []).push(name);
      } else {
        put(r.tid, r.sid, r.w, name === "Weal Paddock" ? `Paddock ${v}` : `${name}: ${v}`);
        if (name === "Drafted" && /send/i.test(v)) (flags[`${r.tid}:${r.sid}`] ||= []).push("Drafted: Send");
      }
    }
    for (const r of acts) {
      const name = traitName(r.code);
      put(r.tid, r.sid, r.w, name === "Purchsed" ? "Purchased" : name);
      if (/^sending/i.test(name)) (flags[`${r.tid}:${r.sid}`] ||= []).push(name);
    }
    for (const p of processed.values()) {
      events.push({ tid: p.tid, sid: p.sid, date: p.date, time: p.time, kind: "treatment", text: p.items.join(" · ") });
    }

    if (has("Note")) {
      for (const n of t.prepare("SELECT animal_id tid, created, note, session_id sid FROM Note WHERE is_deleted = 0").all() as Array<{ tid: number; created: unknown; note: string | null; sid: number | null }>) {
        const when = fromTicks(n.created);
        const text = clean(n.note);
        if (when && text) events.push({ tid: n.tid, sid: n.sid || null, date: when.date, time: when.time, kind: "note", text });
      }
    }

    const life: Record<number, TsiLife[]> = {};
    if (has("AnimalEvents")) {
      for (const e of t.prepare(`SELECT animal_id tid, event_type kind, event_date d, notes FROM AnimalEvents
        WHERE event_type IN ('Death', 'Sale', 'Purchase', 'Transfer In') ORDER BY event_date`).all() as Array<{ tid: number; kind: string; d: unknown; notes: string | null }>) {
        const when = fromTicks(e.d);
        if (when) (life[e.tid] ||= []).push({ kind: e.kind, date: when.date, note: clean(e.notes) ?? "" });
      }
    }

    // The sessions each animal was really in. Some sessions only scanned
    // the whole list to tidy it ("Data cleanup", and a "sending to arcadian"
    // that touched 3,162 head): an animal with nothing recorded in a session
    // where most had nothing recorded wasn't in the yards that day.
    const recorded = new Set([...traits, ...acts].map((r) => `${r.tid}:${r.sid}`));
    const scans = t.prepare("SELECT animal_id tid, session_id sid FROM SessionAnimal WHERE is_deleted = 0 ORDER BY scan_date").all() as Array<{ tid: number; sid: number }>;
    const share = new Map<number, { n: number; rec: number }>();
    for (const r of scans) {
      const x = share.get(r.sid) ?? { n: 0, rec: 0 };
      x.n++;
      if (recorded.has(`${r.tid}:${r.sid}`)) x.rec++;
      share.set(r.sid, x);
    }
    const seen: Record<number, number[]> = {};
    for (const r of scans) {
      const x = share.get(r.sid)!;
      if (!recorded.has(`${r.tid}:${r.sid}`) && x.rec < x.n / 2) continue;
      const s = (seen[r.tid] ||= []);
      if (s[s.length - 1] !== r.sid) s.push(r.sid);
    }

    // Someone else's cattle: Purchased (or TSi's "Purchsed") = No, never Yes.
    const isPurchased = (code: number) => /^purcha?s?e?d$|^purchsed$/i.test(traitName(code).trim());
    const said = new Map<number, { no: Set<number>; yes: boolean }>();
    for (const r of traits) {
      if (!isPurchased(r.code)) continue;
      const v = clean(r.v);
      const x = said.get(r.tid) ?? { no: new Set<number>(), yes: false };
      if (v && /^no$/i.test(v)) x.no.add(r.sid);
      if (v && /^yes$/i.test(v)) x.yes = true;
      said.set(r.tid, x);
    }
    for (const r of acts) if (isPurchased(r.code)) said.set(r.tid, { ...(said.get(r.tid) ?? { no: new Set<number>() }), yes: true });
    const inApp = db.prepare("SELECT 1 FROM animals WHERE eid = ?");
    const out = new Set<number>();
    const keptInApp: NotOurs["in_app"] = [];
    const bySession = new Map<number, number>();
    for (const [tid, x] of said) {
      if (x.yes || x.no.size === 0) continue;
      const a = animals.find((y) => y.tid === tid);
      if (a?.eid && inApp.get(a.eid)) { keptInApp.push({ tag: a.tag, eid: a.eid }); continue; }
      out.add(tid);
      for (const sid of x.no) bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
    }
    const sessName = new Map(sessions.map((x) => [x.tid, x]));
    const not_ours: NotOurs = {
      head: out.size,
      sessions: [...bySession].map(([sid, head]) => ({ name: sessName.get(sid)?.name ?? `session ${sid}`, date: sessName.get(sid)?.date ?? "", head })),
      in_app: keptInApp,
    };
    const keep = <T extends { tid: number }>(xs: T[]) => xs.filter((x) => !out.has(x.tid));
    for (const tid of out) { delete life[tid]; delete seen[tid]; }
    for (const k of Object.keys(flags)) if (out.has(Number(k.split(":")[0]))) delete flags[k];

    const last = sessions.reduce((m, s) => (s.date > m ? s.date : m), "");
    return { backup_date: last, animals: keep(animals), sessions, events: keep(events), life, seen, flags, not_ours };
  } finally {
    t.close();
  }
}

/* ------------------------------- planning -------------------------------- */

/** Where a session name or its draft flags say the animals were going. */
function destinationOf(name: string, flags: string[]): string | null {
  const all = `${name} ${flags.join(" ")}`;
  if (/arcadian|acadian/i.test(all)) return "Arcadian";
  if (/teys/i.test(all)) return "Teys";
  if (/meat ?work/i.test(all)) return "meatworks";
  if (/hewitt/i.test(all) && /send|truck/i.test(all)) return "Hewitt";
  if (/send|truck/i.test(name) || /drafted: send/i.test(all)) return "unknown (trucked out)";
  return null;
}

/** A TSi write-off note that says the animal died, or was sold. */
const DIED = /deceased|dead|death|lightning|euth|put down|killer|3.?day|parali|paraly/i;
const SOLD = /sold|sent to|meatworks/i;
/** A death with fewer than this many others written off on the same day is taken as real. */
const SMALL_DAY = 3;
/** Animals TSi still calls current, but not scanned for this long, are taken as gone. */
const STALE_DAYS = 730;

export type Ending =
  | { kind: "death"; date: string; text: string | null; data: Record<string, unknown> }
  | { kind: "sale"; date: string; text: string | null; data: Record<string, unknown> }
  | { kind: "gone"; date: string; text: string; data: Record<string, unknown> };

interface AppAnimal { id: number; eid: string | null; tag: string | null; nlis: string | null; sex: string | null; breed: string | null; birth_date: string | null; origin: string | null; data: string }

export interface TsiCohort {
  /** TSi session the animals were last seen in. */
  sid: number;
  name: string;
  date: string;
  head: number;
  sexes: Record<string, number>;
  mean_kg: number | null;
  /** App mobs some of these animals are already in, by EID. */
  in_app: Array<{ mob_id: number; name: string; count: number }>;
}

export interface TsiPlan {
  backup_date: string;
  animals: number;
  matched: number;
  new_animals: number;
  sessions: number;
  sessions_reused: Array<{ tsi: string; app: string }>;
  weights: number;
  weights_already: number;
  scores: number;
  processed: number;
  notes: number;
  endings: { death: number; sale: number; gone: number; gone_by: Record<string, number> };
  /** TSi current, not in an app mob, not shown to have left: by the session last seen in. */
  unplaced: TsiCohort[];
  unplaced_total: number;
  /** Already in app mobs: TSi's own status for them. */
  matched_by_mob: Array<{ mob_id: number; name: string; head: number; records_before: number; tsi_matched: number; tsi_status: Record<string, number> }>;
  conflicts: Array<{ tag: string | null; eid: string | null; mob: string; tsi: string }>;
  not_ours: NotOurs;
}

interface Prepared {
  backup: TsiBackup;
  app: Map<number, AppAnimal>;   // tid → existing app animal
  appMob: Map<number, number>;   // app animal id → current mob
  endings: Map<number, Ending>;  // tid → ending (new animals only)
  unplaced: Map<number, number>; // tid → TSi session last seen in
  sessionFor: Map<number, number | null>; // TSi sid → existing app weigh_session id
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function prepare(b: TsiBackup): Prepared {
  const byEid = new Map<string, AppAnimal>();
  const byTag = new Map<string, AppAnimal[]>();
  for (const a of db.prepare("SELECT id, eid, tag, nlis, sex, breed, birth_date, origin, data FROM animals").all() as AppAnimal[]) {
    if (a.eid) byEid.set(a.eid, a);
    if (a.tag) byTag.set(a.tag.toLowerCase(), [...(byTag.get(a.tag.toLowerCase()) ?? []), a]);
  }
  const app = new Map<number, AppAnimal>();
  for (const a of b.animals) {
    const hit = a.eid ? byEid.get(a.eid) : (a.tag && byTag.get(a.tag.toLowerCase())?.length === 1 ? byTag.get(a.tag.toLowerCase())![0] : undefined);
    if (hit && !(a.eid && hit.eid && hit.eid !== a.eid)) app.set(a.tid, hit);
  }

  // Each app animal's mob now, and whether it has ended.
  const appMob = new Map<number, number>();
  for (const e of db.prepare("SELECT animal_id, kind, mob_id FROM animal_events ORDER BY date, IFNULL(time, ''), id").all() as Array<{ animal_id: number; kind: string; mob_id: number | null }>) {
    if (e.kind === "join" && e.mob_id !== null) appMob.set(e.animal_id, e.mob_id);
    if ((e.kind === "leave" && appMob.get(e.animal_id) === e.mob_id) || ["death", "sale", "gone"].includes(e.kind)) appMob.delete(e.animal_id);
  }

  const sess = new Map(b.sessions.map((s) => [s.tid, s]));
  // How many were written off as dead on each day, to tell a tidy-up from a death.
  const deathsOn = new Map<string, number>();
  for (const a of b.animals) {
    if (a.status !== "Dead") continue;
    const d = [...(b.life[a.tid] ?? [])].reverse().find((l) => l.kind === "Death");
    if (d) deathsOn.set(d.date, (deathsOn.get(d.date) ?? 0) + 1);
  }

  const endings = new Map<number, Ending>();
  const unplaced = new Map<number, number>();
  for (const a of b.animals) {
    if (app.has(a.tid)) continue;
    const seen = b.seen[a.tid] ?? [];
    const lastSid = seen[seen.length - 1];
    const last = lastSid !== undefined ? sess.get(lastSid) : undefined;
    const lastFlags = lastSid !== undefined ? b.flags[`${a.tid}:${lastSid}`] ?? [] : [];
    const dest = last ? destinationOf(last.name, lastFlags) : null;
    const lifeEv = b.life[a.tid] ?? [];
    const sale = [...lifeEv].reverse().find((l) => l.kind === "Sale");
    const lastSeen = last?.date ?? null;
    const lastSeenData = last ? { last_seen: last.date, last_session: last.name || "(unnamed session)" } : {};

    if (a.status === "Dead") {
      const d = [...lifeEv].reverse().find((l) => l.kind === "Death");
      const date = d?.date ?? lastSeen ?? b.backup_date;
      const note = d?.note ?? "";
      if (DIED.test(note)) {
        endings.set(a.tid, { kind: "death", date, text: note, data: { from: "TSi" } });
      } else if (SOLD.test(note)) {
        endings.set(a.tid, { kind: "sale", date, text: note, data: { destination: destinationOf(note, []) ?? note, from: "TSi" } });
      } else if (sale) {
        endings.set(a.tid, { kind: "sale", date: sale.date, text: sale.note || null, data: { ...(destinationOf(sale.note, []) ? { destination: destinationOf(sale.note, []) } : {}), from: "TSi" } });
      } else if (note) {
        // A tidy-up with its reason: "Not seen in 4 years", "Cows over 3 years not breeders".
        endings.set(a.tid, {
          kind: "gone", date, text: `Written off in TSi: ${note}${lastSeen ? ` (last scanned ${lastSeen}${dest ? `, "${last!.name}"` : ""})` : ""}`,
          data: { written_off: date, reason: note, ...(dest ? { destination: dest } : {}), ...lastSeenData, from: "TSi" },
        });
      } else if (dest) {
        endings.set(a.tid, {
          kind: "gone", date: lastSeen!, text: `Left the herd, probably to ${dest}: last scanned in "${last!.name || "an unnamed session"}"; marked dead in TSi on ${date}`,
          data: { destination: dest, written_off: date, ...lastSeenData, from: "TSi" },
        });
      } else if ((deathsOn.get(date) ?? 0) <= SMALL_DAY) {
        endings.set(a.tid, { kind: "death", date, text: d?.note || null, data: { from: "TSi", cause_unknown: true } });
      } else {
        endings.set(a.tid, {
          kind: "gone", date, text: `Written off in TSi on ${date} with ${deathsOn.get(date)} others; how it left isn't recorded${lastSeen ? ` (last scanned ${lastSeen})` : ""}`,
          data: { written_off: date, ...lastSeenData, from: "TSi" },
        });
      }
      continue;
    }
    // TSi still has it.
    if (sale && (!lastSeen || sale.date >= lastSeen)) {
      endings.set(a.tid, { kind: "sale", date: sale.date, text: sale.note || null, data: { destination: destinationOf(sale.note, []) ?? (sale.note || undefined), from: "TSi" } });
    } else if (dest && last) {
      endings.set(a.tid, {
        kind: "gone", date: last.date, text: `Left the herd, probably to ${dest}: last scanned in "${last.name || "an unnamed session"}" and not since; TSi still lists it as current`,
        data: { destination: dest, ...lastSeenData, from: "TSi" },
      });
    } else if (!last || daysBetween(last.date, b.backup_date) > STALE_DAYS) {
      const date = last?.date ?? b.backup_date;
      endings.set(a.tid, {
        kind: "gone", date, text: last ? `Not scanned since ${last.date} ("${last.name || "unnamed session"}"); TSi still lists it as current` : "Never scanned in a session; TSi lists it as current",
        data: { ...lastSeenData, stale: true, from: "TSi" },
      });
    } else {
      unplaced.set(a.tid, lastSid!);
    }
  }

  // TSi sessions already brought in from a CSV export.
  const appSessions = db.prepare("SELECT id, name, date FROM weigh_sessions").all() as Array<{ id: number; name: string; date: string }>;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sessionFor = new Map<number, number | null>();
  for (const s of b.sessions) {
    const hit = appSessions.find((x) => x.date === s.date && (norm(x.name) === norm(s.name) || (!s.name && /^session$/i.test(x.name))));
    sessionFor.set(s.tid, hit?.id ?? null);
  }
  return { backup: b, app, appMob, endings, unplaced, sessionFor };
}

export function planTsi(b: TsiBackup): TsiPlan {
  const p = prepare(b);
  const sess = new Map(b.sessions.map((s) => [s.tid, s]));
  const mobNames = new Map((db.prepare("SELECT id, name FROM mobs").all() as Array<{ id: number; name: string }>).map((m) => [m.id, m.name]));

  // Weights the app already has (a session imported from CSV, or Optiweigh).
  const have = new Set((db.prepare("SELECT animal_id, date, weight_kg FROM animal_events WHERE kind = 'weigh'").all() as Array<{ animal_id: number; date: string; weight_kg: number }>)
    .map((r) => `${r.animal_id}|${r.date}|${r.weight_kg}`));
  let weights = 0, already = 0, scores = 0, processed = 0, notes = 0;
  for (const e of b.events) {
    if (e.kind === "weigh") {
      const a = p.app.get(e.tid);
      if (a && have.has(`${a.id}|${e.date}|${e.weight_kg}`)) already++; else weights++;
    } else if (e.kind === "score") scores++;
    else if (e.kind === "treatment") processed++;
    else notes++;
  }

  const endings = { death: 0, sale: 0, gone: 0, gone_by: {} as Record<string, number> };
  for (const e of p.endings.values()) {
    endings[e.kind]++;
    if (e.kind === "gone") {
      const why = typeof e.data["destination"] === "string" ? `to ${e.data["destination"]}` : e.data["stale"] ? "not scanned for 2+ years" : "written off in a TSi tidy-up";
      endings.gone_by[why] = (endings.gone_by[why] ?? 0) + 1;
    }
  }

  // Cohorts of animals still current but not in any mob here.
  const byTid = new Map(b.animals.map((a) => [a.tid, a]));
  const lastKg = new Map<number, number>();
  for (const e of b.events) if (e.kind === "weigh") lastKg.set(e.tid, e.weight_kg!);
  const cohorts = new Map<number, TsiCohort>();
  for (const [tid, sid] of p.unplaced) {
    const s = sess.get(sid)!;
    const c = cohorts.get(sid) ?? { sid, name: s.name || "(unnamed session)", date: s.date, head: 0, sexes: {}, mean_kg: null, in_app: [] };
    c.head++;
    const sx = byTid.get(tid)?.sex ?? "unknown";
    c.sexes[sx] = (c.sexes[sx] ?? 0) + 1;
    cohorts.set(sid, c);
  }
  // Which app mobs the rest of each cohort's session is in, by EID.
  for (const c of cohorts.values()) {
    const kgs = [...p.unplaced].filter(([, sid]) => sid === c.sid).map(([tid]) => lastKg.get(tid)).filter((k): k is number => k !== undefined);
    c.mean_kg = kgs.length ? Math.round(kgs.reduce((x, y) => x + y, 0) / kgs.length) : null;
    const inMob = new Map<number, number>();
    for (const a of b.animals) {
      const seen = b.seen[a.tid] ?? [];
      if (!seen.includes(c.sid)) continue;
      const appA = p.app.get(a.tid);
      const m = appA ? p.appMob.get(appA.id) : undefined;
      if (m !== undefined) inMob.set(m, (inMob.get(m) ?? 0) + 1);
    }
    c.in_app = [...inMob].map(([mob_id, count]) => ({ mob_id, name: mobNames.get(mob_id) ?? `#${mob_id}`, count })).sort((x, y) => y.count - x.count);
  }

  // Mobs on hand: head, records the app has, and what TSi says of the matched ones.
  const records = new Map<number, number>();
  for (const m of p.appMob.values()) records.set(m, (records.get(m) ?? 0) + 1);
  const tsiIn = new Map<number, { n: number; st: Record<string, number> }>();
  const conflicts: TsiPlan["conflicts"] = [];
  for (const [tid, a] of p.app) {
    const m = p.appMob.get(a.id);
    if (m === undefined) continue;
    const t = byTid.get(tid)!;
    const x = tsiIn.get(m) ?? { n: 0, st: {} };
    x.n++;
    x.st[t.status || "?"] = (x.st[t.status || "?"] ?? 0) + 1;
    tsiIn.set(m, x);
    if (t.status === "Dead") {
      const d = [...(b.life[tid] ?? [])].reverse().find((l) => l.kind === "Death");
      conflicts.push({ tag: t.tag, eid: t.eid, mob: mobNames.get(m) ?? `#${m}`, tsi: `marked dead ${d?.date ?? ""}${d?.note ? `: ${d.note}` : ""}` });
    }
  }
  const matched_by_mob = mobViews().map((v) => ({
    mob_id: v.mob.id, name: v.mob.name, head: v.state.head,
    records_before: records.get(v.mob.id) ?? 0,
    tsi_matched: tsiIn.get(v.mob.id)?.n ?? 0,
    tsi_status: tsiIn.get(v.mob.id)?.st ?? {},
  }));

  const usedSessions = new Set(b.events.map((e) => e.sid).filter((s): s is number => s !== null));
  const reused = [...p.sessionFor].filter(([, id]) => id !== null).map(([sid, id]) => ({
    tsi: `${sess.get(sid)?.date} ${sess.get(sid)?.name || "(unnamed)"}`,
    app: (db.prepare("SELECT name FROM weigh_sessions WHERE id = ?").get(id) as { name: string }).name,
  }));

  return {
    backup_date: b.backup_date,
    animals: b.animals.length, matched: p.app.size, new_animals: b.animals.length - p.app.size,
    sessions: usedSessions.size, sessions_reused: reused,
    weights, weights_already: already, scores, processed, notes,
    endings,
    unplaced: [...cohorts.values()].sort((x, y) => y.date.localeCompare(x.date)),
    unplaced_total: p.unplaced.size,
    matched_by_mob,
    conflicts,
    not_ours: b.not_ours ?? { head: 0, sessions: [], in_app: [] },
  };
}

/* ------------------------------- importing ------------------------------- */

/**
 * Brings the whole backup in as one batch, so one Undo takes it all out
 * again. `place` puts a cohort (by the TSi session it was last seen in) into
 * a mob from the day it was last scanned, or records it as gone.
 */
export function commitTsi(
  b: TsiBackup, opts: { filename: string; place?: Record<string, number | "gone" | null> }, username: string | null
): { batch: string; created: number; updated: number; events: number; sessions: number; placed: number } {
  const p = prepare(b);
  const batch = randomUUID();
  const now = Date.now();
  const source = "tsi";
  const sess = new Map(b.sessions.map((s) => [s.tid, s]));
  const place = opts.place ?? {};
  for (const v of Object.values(place)) {
    if (typeof v === "number" && !db.prepare("SELECT 1 FROM mobs WHERE id = ?").get(v)) throw new StockError("No such mob");
  }

  const insAnimal = db.prepare(`INSERT INTO animals (eid, tag, nlis, sex, breed, birth_date, origin, data, source, batch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fill = db.prepare(`UPDATE animals SET tag = COALESCE(tag, ?), nlis = COALESCE(nlis, ?), sex = COALESCE(sex, ?), breed = COALESCE(breed, ?),
    birth_date = COALESCE(birth_date, ?), origin = COALESCE(origin, ?), data = ?, updated_at = ? WHERE id = ?`);
  const insEvent = db.prepare(`INSERT INTO animal_events (animal_id, date, time, kind, mob_id, weight_kg, score, text, session_id, data, source, batch, username, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insSession = db.prepare(`INSERT INTO weigh_sessions (name, date, source, filename, animal_count, mob_id, batch, username, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`);
  const have = new Set((db.prepare("SELECT animal_id, date, weight_kg FROM animal_events WHERE kind = 'weigh'").all() as Array<{ animal_id: number; date: string; weight_kg: number }>)
    .map((r) => `${r.animal_id}|${r.date}|${r.weight_kg}`));
  const firstEvent = (mob: number) => (db.prepare("SELECT MIN(date) d FROM mob_events WHERE mob_id = ?").get(mob) as { d: string | null }).d;

  return db.transaction(() => {
    // Sessions: reuse one already brought in from CSV, else create it.
    const used = new Set(b.events.map((e) => e.sid).filter((s): s is number => s !== null));
    const sid = new Map<number, number>();
    let sessions = 0;
    for (const s of b.sessions) {
      if (!used.has(s.tid)) continue;
      const existing = p.sessionFor.get(s.tid);
      if (existing) { sid.set(s.tid, existing); continue; }
      sid.set(s.tid, Number(insSession.run((s.name || "Unnamed session").slice(0, 120), s.date, "tsi", opts.filename, s.head, batch, username, now).lastInsertRowid));
      sessions++;
    }

    // Animals.
    const id = new Map<number, number>();
    let created = 0, updated = 0;
    for (const a of b.animals) {
      const data = { tsi: { id: a.tid, status: a.status, ...a.info } };
      const hit = p.app.get(a.tid);
      if (hit) {
        const old = JSON.parse(hit.data) as Record<string, unknown>;
        fill.run(a.tag, a.nlis, a.sex, a.breed, a.birth_date, a.origin, JSON.stringify({ ...old, ...data }), now, hit.id);
        id.set(a.tid, hit.id);
        updated++;
      } else {
        id.set(a.tid, Number(insAnimal.run(a.eid, a.tag, a.nlis, a.sex, a.breed, a.birth_date, a.origin, JSON.stringify(data), source, batch, now, now).lastInsertRowid));
        created++;
      }
    }

    // History.
    let events = 0;
    const add = (animal: number, e: { date: string; time?: string | null; kind: string; mob_id?: number | null; weight_kg?: number | null; score?: number | null; text?: string | null; session_id?: number | null; data?: Record<string, unknown> }) => {
      insEvent.run(animal, e.date, e.time ?? null, e.kind, e.mob_id ?? null, e.weight_kg ?? null, e.score ?? null, e.text ?? null,
        e.session_id ?? null, JSON.stringify(e.data ?? {}), source, batch, username, now);
      events++;
    };
    for (const e of b.events) {
      const animal = id.get(e.tid);
      if (animal === undefined) continue;
      if (e.kind === "weigh") {
        const k = `${animal}|${e.date}|${e.weight_kg}`;
        if (have.has(k)) continue;
        have.add(k);
      }
      add(animal, {
        date: e.date, time: e.time, kind: e.kind, weight_kg: e.weight_kg ?? null, score: e.score ?? null,
        text: e.text ?? null, session_id: e.sid !== null ? sid.get(e.sid) ?? null : null,
      });
    }
    // Purchases and transfers in, as notes: they say where an animal came from.
    for (const a of b.animals) {
      for (const l of b.life[a.tid] ?? []) {
        if (l.kind !== "Purchase" && l.kind !== "Transfer In") continue;
        add(id.get(a.tid)!, { date: l.date, kind: "note", text: `${l.kind === "Purchase" ? "Purchased" : "Transferred in"}${l.note ? `: ${l.note}` : ""}` });
      }
    }
    for (const [tid, e] of p.endings) add(id.get(tid)!, { date: e.date, kind: e.kind, text: e.text, data: e.data });

    // Cohorts placed into mobs, or recorded as gone.
    let placed = 0;
    for (const [tid, last] of p.unplaced) {
      const choice = place[String(last)];
      if (choice === undefined || choice === null) continue;
      const s = sess.get(last)!;
      if (choice === "gone") {
        add(id.get(tid)!, { date: s.date, kind: "gone", text: `Not in any mob here; last scanned in "${s.name || "an unnamed session"}"`, data: { last_seen: s.date, last_session: s.name, from: "import review" } });
      } else {
        const first = firstEvent(choice);
        add(id.get(tid)!, { date: first && first > s.date ? first : s.date, kind: "join", mob_id: choice, data: { from: `TSi session "${s.name || "unnamed"}" ${s.date}` } });
      }
      placed++;
    }
    return { batch, created, updated, events, sessions, placed };
  })();
}
