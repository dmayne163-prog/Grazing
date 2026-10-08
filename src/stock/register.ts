/**
 * The head count register: every record that changed a mob's head count, in
 * order, with the head before and after, the property's total after, and the
 * notes taken at the time and since — what's needed to explain, come audit
 * time, why the numbers on hand differ from what was expected.
 *
 * Nothing is left out to make it tidy. Records struck out as mistakes are
 * listed (not counted) with the reason given; records undone in the app are
 * kept from the moment of undoing (undone_mob_events) and listed too. Notes
 * can be added to a line later, but never changed or removed.
 */
import { db } from "../db/database.js";
import { EVENT_ORDER, type MobEventRow, voidedIds } from "./store.js";
import { StockError } from "./actions.js";

export interface RegisterRow {
  id: number | null;
  date: string;
  time: string | null;
  mob_id: number;
  mob: string;
  owner: string | null;
  what: string;
  /** Whether it changed the property's total, not just moved cattle between mobs. */
  property: boolean;
  change: number;
  before: number;
  after: number;
  property_after: number;
  other_mob: string | null;
  notes: string[];
  later_notes: Array<{ text: string; by: string | null; at: number }>;
  recorded_by: string | null;
  recorded_at: number;
  source: string;
  /** "struck out" (voided) or "undone": listed, not counted. */
  status: "counted" | "struck out" | "undone";
  status_note: string | null;
}

const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const WHAT: Record<string, string> = {
  purchase: "Purchase", sale: "Sale", death: "Death", count: "Recount", opening: "Opening count",
};

/** Keeps a copy of records about to be deleted by an undo, so the register still shows them. */
export function keepUndone(where: string, arg: unknown, username: string | null) {
  const rows = db.prepare(`SELECT * FROM mob_events WHERE ${where}`).all(arg) as MobEventRow[];
  const ins = db.prepare("INSERT INTO undone_mob_events (event, undone_by, undone_at) VALUES (?, ?, ?)");
  const now = Date.now();
  for (const r of rows) {
    if (r.head_change !== null || r.kind === "count" || (r.kind === "opening" && r.head !== null)) ins.run(JSON.stringify(r), username, now);
  }
}

export function addRegisterNote(eventId: number, textRaw: unknown, username: string | null) {
  const text = typeof textRaw === "string" ? textRaw.trim().slice(0, 1000) : "";
  if (!text) throw new StockError("Write the note first");
  if (!db.prepare("SELECT 1 FROM mob_events WHERE id = ?").get(eventId)) throw new StockError("No such record");
  db.prepare("INSERT INTO mob_event_notes (event_id, text, username, created_at) VALUES (?, ?, ?, ?)").run(eventId, text, username, Date.now());
}

export function headRegister(opts: { from?: string; to?: string; mob_name?: string; property_only?: boolean }) {
  const voided = voidedIds();
  const voidReason = new Map<number, string | null>();
  for (const r of db.prepare("SELECT data FROM mob_events WHERE kind = 'void'").all() as Array<{ data: string }>) {
    const d = JSON.parse(r.data) as { voids?: number; reason?: string };
    if (typeof d.voids === "number") voidReason.set(d.voids, d.reason ?? null);
  }
  const mobs = new Map((db.prepare("SELECT id, name, owner FROM mobs").all() as Array<{ id: number; name: string; owner: string | null }>).map((m) => [m.id, m]));
  const laterNotes = new Map<number, RegisterRow["later_notes"]>();
  for (const n of db.prepare("SELECT event_id, text, username, created_at FROM mob_event_notes ORDER BY created_at").all() as Array<{ event_id: number; text: string; username: string | null; created_at: number }>) {
    laterNotes.set(n.event_id, [...(laterNotes.get(n.event_id) ?? []), { text: n.text, by: n.username, at: n.created_at }]);
  }

  // Every record in order, as the head counts are folded; undone ones beside them.
  const events = db.prepare(`SELECT * FROM mob_events WHERE kind != 'void' ORDER BY ${EVENT_ORDER}`).all() as MobEventRow[];
  const undone = (db.prepare("SELECT event, undone_by, undone_at FROM undone_mob_events").all() as Array<{ event: string; undone_by: string | null; undone_at: number }>)
    .map((u) => ({ ...(JSON.parse(u.event) as MobEventRow), undone_by: u.undone_by, undone_at: u.undone_at }));
  const all = [...events.map((e) => ({ e, undo: null as null | { by: string | null; at: number } })),
    ...undone.map((u) => ({ e: u as MobEventRow, undo: { by: u.undone_by, at: u.undone_at } }))]
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || (a.e.kind === "opening" ? 0 : 1) - (b.e.kind === "opening" ? 0 : 1)
      || (a.e.time ?? "").localeCompare(b.e.time ?? "") || a.e.id - b.e.id);

  // AgriWebb's mob list became opening counts. Those from its first week are
  // what was on hand when records began; a later "Purchased" was a purchase.
  const firstOpening = events.find((e) => e.kind === "opening")?.date ?? null;
  const setupWeek = (d: string) => firstOpening !== null && (Date.parse(d) - Date.parse(firstOpening)) / 86_400_000 <= 7;
  const head = new Map<number, number>();
  const started = new Set<number>();
  let total = 0;
  const rows: RegisterRow[] = [];
  for (const { e, undo } of all) {
    const counts = !undo && !voided.has(e.id);
    const before = head.get(e.mob_id) ?? 0;
    let after = before;
    let changes = false;
    if (e.head !== null && (e.kind === "count" || (e.kind === "opening" && !started.has(e.mob_id)))) { after = e.head; changes = true; }
    if (e.kind === "opening" && counts) started.add(e.mob_id);
    if (e.head_change !== null) { after += e.head_change; changes = true; }
    if (!changes) continue;
    if (counts) {
      head.set(e.mob_id, after);
      total += after - before;
    }
    const data = JSON.parse(e.data) as Record<string, unknown>;
    const otherId = (data["to_mob"] ?? data["from_mob"] ?? data["drafted_from"]) as number | undefined;
    const internal = typeof otherId === "number" && !data["off_farm"];
    const what = e.kind === "transfer"
      ? data["off_farm"] ? (Number(e.head_change) < 0 ? "Transfer off farm" : "Transfer on to farm")
      : data["merged"] ? (Number(e.head_change) < 0 ? "Merged into" : "Merged in from")
      : Number(e.head_change) < 0 ? "Drafted to" : "Drafted from"
      : e.kind === "opening"
        ? data["drafted_from"] ? "Drafted from"
          : e.source === "app" ? "New mob"
          : setupWeek(e.date) || String(data["agriwebb_event"] ?? "").includes("records began") ? "On hand when records began"
          : data["agriwebb_event"] === "Purchased" ? "Purchase" : "New mob"
        : WHAT[e.kind] ?? e.kind;
    const notes = [data["note"], data["reason"], data["destination"] ? `to ${String(data["destination"])}` : null, data["agriwebb_event"] && e.source !== "app" ? `AgriWebb: ${String(data["agriwebb_event"])}${data["recorded_by"] ? `, by ${String(data["recorded_by"])}` : ""}` : null]
      .filter((x): x is string => typeof x === "string" && x !== "");
    const m = mobs.get(e.mob_id);
    rows.push({
      id: undo ? null : e.id, date: e.date, time: e.time, mob_id: e.mob_id, mob: m?.name ?? `mob #${e.mob_id}`, owner: m?.owner ?? null,
      what, property: !internal, change: after - before, before, after, property_after: total,
      other_mob: typeof otherId === "number" ? mobs.get(otherId)?.name ?? `mob #${otherId}` : null,
      notes, later_notes: undo ? [] : laterNotes.get(e.id) ?? [],
      recorded_by: e.username ?? (typeof data["recorded_by"] === "string" ? data["recorded_by"] : null), recorded_at: e.created_at,
      source: e.source === "app" ? "this app" : e.source.startsWith("session") ? "scales session" : e.source.startsWith("import") || e.source.startsWith("agriwebb") ? "AgriWebb import" : e.source,
      status: undo ? "undone" : voided.has(e.id) ? "struck out" : "counted",
      status_note: undo ? `${localDate(undo.at)}${undo.by ? ` by ${undo.by}` : ""}` : voided.has(e.id) ? voidReason.get(e.id) ?? null : null,
    });
  }
  const shown = rows.filter((r) =>
    (!opts.from || r.date >= opts.from) && (!opts.to || r.date <= opts.to) &&
    (!opts.mob_name || r.mob === opts.mob_name) && (!opts.property_only || r.property));
  const counted = shown.filter((r) => r.status === "counted");
  const sum = (what: (r: RegisterRow) => boolean) => counted.filter(what).reduce((t, r) => t + r.change, 0);
  return {
    rows: shown.reverse(),
    mob_names: [...new Set(rows.map((r) => r.mob))].sort(),
    totals: {
      purchases: sum((r) => r.what === "Purchase" || r.what === "Transfer on to farm" || r.what === "New mob"),
      sales: sum((r) => r.what === "Sale" || r.what === "Transfer off farm"),
      deaths: sum((r) => r.what === "Death"),
      recounts: sum((r) => r.what === "Recount"),
      net: sum((r) => r.property),
    },
    property_now: total,
  };
}
