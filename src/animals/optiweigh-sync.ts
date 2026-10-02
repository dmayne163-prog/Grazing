/**
 * Optiweigh's API, pulled each morning: the session list, then each day's
 * individual weights for every session that's been assigned (to a mob, or as a
 * record only). Sessions nobody has assigned yet are held, not guessed — the
 * unit's GPS often sits on a fence-line trough and mobs share units, so a mob
 * is only ever chosen by a person.
 *
 * Each day is fetched with the single-day endpoint: the date-range one gives
 * 5-day rolling averages, which aren't the same thing.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { db, getSetting, setSetting } from "../db/database.js";
import { logger } from "../logger.js";
import { StockError } from "../stock/actions.js";
import { today } from "../stock/store.js";
import { recordOptiweighDay, refreshOptiweighWeeks, type OptiweighApiRecord, type OptiweighSessionUse } from "./store.js";

const log = logger("optiweigh");
const API = "https://api.optiweigh.io";
/** The latest days are fetched again each time: a day's average firms up as its readings come in. */
const REFETCH_DAYS = 2;
/** At most this many days in one run, so a long backfill can't hog the service. */
const MAX_DAYS = 400;

export const optiweighConfigured = () => !!config.optiweighKey && config.optiweighClientId > 0;

/** Between requests: Optiweigh limits how fast a key may ask (429 at several a second). */
const PACE_MS = 1100;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** One request; told to slow down (429) or briefly unavailable (5xx), it waits and tries again. */
async function call<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { "x-api-key": config.optiweighKey }, signal: AbortSignal.timeout(60_000) });
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 10_000 * attempt);
      continue;
    }
    let msg = `${res.status}`;
    try { msg += ` ${((await res.json()) as { message?: string }).message ?? ""}`; } catch { /* no body */ }
    throw new Error(`Optiweigh answered ${msg.trim()}`);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toApi = (iso: string) => `${Number(iso.slice(8, 10))}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const fromApi = (d: string) => {
  const [dd, mmm, yyyy] = d.split("-");
  return `${yyyy}-${String(MONTHS.indexOf(mmm ?? "") + 1).padStart(2, "0")}-${(dd ?? "").padStart(2, "0")}`;
};
const shift = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

export interface SessionRow {
  session_id: number; name: string | null; start_date: string | null; end_date: string | null; status: string | null;
  mob_id: number | null; record_only: number; synced_to: string | null; assigned_by: string | null; updated_at: number;
}

/**
 * The day the link was switched on. Sessions that had ended before it are
 * kept as records only — their weights on each animal, not tied to any mob.
 */
function linkedFrom(): string {
  let d = getSetting("optiweigh_linked_from");
  if (!d) { d = today(); setSetting("optiweigh_linked_from", d); }
  return d;
}

async function refreshSessions(): Promise<SessionRow[]> {
  const list = await call<Array<{ sessionId: number; name: string | null; startDate: string; endDate: string | null; status: string }>>(
    `/v2/clients/${config.optiweighClientId}/sessions?status=ALL`);
  const from = linkedFrom();
  const now = Date.now();
  db.transaction(() => {
    for (const s of list) {
      const start = s.startDate?.slice(0, 10) ?? null, end = s.endDate?.slice(0, 10) ?? null;
      db.prepare(`
        INSERT INTO optiweigh_sessions (session_id, name, start_date, end_date, status, record_only, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, start_date = excluded.start_date,
          end_date = excluded.end_date, status = excluded.status, updated_at = excluded.updated_at
      `).run(s.sessionId, s.name, start, end, s.status, end !== null && end < from ? 1 : 0, now);
    }
  })();
  return listSessions();
}

export function listSessions(): SessionRow[] {
  return db.prepare("SELECT * FROM optiweigh_sessions ORDER BY start_date DESC").all() as SessionRow[];
}

export function assignSession(id: number, use: { mob_id: number | null; record_only: boolean }, username: string | null): void {
  if (use.mob_id !== null && !db.prepare("SELECT 1 FROM mobs WHERE id = ?").get(use.mob_id)) throw new StockError("No such mob");
  if (!db.prepare("SELECT 1 FROM optiweigh_sessions WHERE session_id = ?").get(id)) throw new StockError("No such Optiweigh session");
  // Assigning differently starts it over, so its days are fetched again under the new assignment.
  db.prepare("UPDATE optiweigh_sessions SET mob_id = ?, record_only = ?, assigned_by = ?, synced_to = NULL, updated_at = ? WHERE session_id = ?")
    .run(use.mob_id, use.record_only ? 1 : 0, username, Date.now(), id);
}

export interface SyncResult {
  at: number; days: number; created: number; weighed: number; updated: number; held: number;
  mob_weeks: number; waiting: string[]; error: string | null;
}

let running: Promise<SyncResult> | null = null;
export function syncOptiweigh(username: string | null = null): Promise<SyncResult> {
  running ??= doSync(username).finally(() => { running = null; });
  return running;
}
export const syncRunning = () => running !== null;

async function doSync(username: string | null): Promise<SyncResult> {
  let finishWeeks = () => { /* set once the run has dates to work on */ };
  const result: SyncResult = { at: Date.now(), days: 0, created: 0, weighed: 0, updated: 0, held: 0, mob_weeks: 0, waiting: [], error: null };
  if (!optiweighConfigured()) { result.error = "Optiweigh isn't set up on this server"; return result; }
  try {
    const sessions = await refreshSessions();
    const end = today();
    result.waiting = sessions.filter((s) => s.mob_id === null && !s.record_only).map((s) => s.name ?? `#${s.session_id}`);
    // The days each assigned session still needs.
    const need = new Map<string, Set<number>>();
    for (const s of sessions) {
      if ((s.mob_id === null && !s.record_only) || !s.start_date) continue;
      const to = s.end_date && s.end_date < end ? s.end_date : end;
      let d = s.synced_to ? shift(s.synced_to, -REFETCH_DAYS + 1) : s.start_date;
      if (d < s.start_date) d = s.start_date;
      for (; d <= to; d = shift(d, 1)) need.set(d, (need.get(d) ?? new Set()).add(s.session_id));
    }
    const uses = new Map<number, OptiweighSessionUse>(sessions.map((s) => [s.session_id, { mob_id: s.mob_id, record_only: !!s.record_only }]));
    const batch = randomUUID();
    const mobDates = new Map<number, Set<string>>();
    let weeksDone = false;
    finishWeeks = () => {
      if (weeksDone) return;
      weeksDone = true;
      for (const [mob, dates] of mobDates) result.mob_weeks += refreshOptiweighWeeks(mob, dates, username ?? "Optiweigh", batch);
    };
    for (const day of [...need.keys()].sort().slice(0, MAX_DAYS)) {
      const r = await call<{ data?: { dailyRecords?: Array<{ date: string; records: Array<{ eid: string; visId: string; avWt: number; sessionId: number }> }> } }>(
        `/3p-data/clients/${config.optiweighClientId}/raw-daily-weights-adg?date=${toApi(day)}`);
      const wanted = need.get(day)!;
      const recs: OptiweighApiRecord[] = [];
      for (const dr of r.data?.dailyRecords ?? []) {
        for (const x of dr.records) {
          if (!wanted.has(x.sessionId)) continue;
          recs.push({ date: fromApi(dr.date), eid: x.eid, visId: x.visId || null, kg: x.avWt, sessionId: x.sessionId });
        }
      }
      const got = recordOptiweighDay(recs, uses, username ?? "Optiweigh", batch);
      result.days++;
      result.created += got.created;
      result.weighed += got.weighed;
      result.updated += got.updated;
      result.held += got.held;
      for (const [m, ds] of got.mobDates) mobDates.set(m, new Set([...(mobDates.get(m) ?? []), ...ds]));
      // Progress is kept day by day, so a run cut short carries on from here next time.
      for (const sid of wanted) db.prepare("UPDATE optiweigh_sessions SET synced_to = ? WHERE session_id = ?").run(day, sid);
      await sleep(PACE_MS);
    }
    finishWeeks();
    log.info(`Optiweigh: ${result.days} days, ${result.weighed} new weights (${result.updated} updated), ${result.created} new animals, ${result.mob_weeks} mob weeks${result.waiting.length ? `; waiting for a mob: ${result.waiting.join(", ")}` : ""}`);
  } catch (e) {
    try { finishWeeks(); } catch { /* the error below is the one to report */ }
    result.error = e instanceof Error ? e.message : String(e);
    log.warn(`Optiweigh sync failed: ${result.error}`);
  }
  setSetting("optiweigh_last", JSON.stringify(result));
  if (!result.error) setSetting("optiweigh_synced_on", today());
  return result;
}

export function lastSync(): SyncResult | null {
  const s = getSetting("optiweigh_last");
  return s ? (JSON.parse(s) as SyncResult) : null;
}

/** Each morning after OPTIWEIGH_HOUR, and at start-up when today's hasn't run. */
export function startOptiweighSync(): NodeJS.Timeout {
  const due = () => optiweighConfigured() && getSetting("optiweigh_synced_on") !== today();
  const run = () => syncOptiweigh().catch((e) => log.error(`Optiweigh sync failed: ${String(e)}`));
  setTimeout(() => { if (due()) void run(); }, 45_000).unref();
  const t = setInterval(() => {
    if (new Date().getHours() >= config.optiweighHour && due()) void run();
  }, 30 * 60_000);
  t.unref();
  return t;
}
