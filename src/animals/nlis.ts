/**
 * NLIS database reports for the property's PIC, tag by tag:
 *
 * - "Cattle that have moved off PIC": RFID, NLIS ID, destination PIC, NVD,
 *   movement date. Every tagged animal that left, and where to.
 * - "Active cattle moved onto my property": NLIS ID, RFID, source PIC, NVD,
 *   transfer date. Tags NLIS still holds here that came from elsewhere.
 *
 * Every row is kept (nlis_movements) whether or not the app knows the animal:
 * NLIS is the official record, and the gaps between it and the app are the
 * clean-up list. Animals the app has as still alive (in a mob or not) but
 * NLIS shows leaving are recorded as having left, on NLIS's date: a death
 * where NLIS says DECEASED, a sale where it went to a processor, otherwise
 * off the books to the destination PIC. An animal already ended in the app
 * keeps its record; the NLIS row sits beside it. Mob head counts never change.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { StockError } from "../stock/actions.js";
import { normaliseEid, parseCsv } from "./session.js";
import { addAnimalEvent, allSummaries } from "./store.js";

export interface NlisRow {
  direction: "off" | "on";
  eid: string | null;
  nlis_id: string | null;
  pic: string | null;      // destination (off) or source (on)
  nvd: string | null;
  date: string;
}

/** Processors the property sends to, by PIC: a move there is a sale to slaughter. */
const PROCESSORS: Record<string, string> = {
  QABB1620: "ACC Cannon Hill",
  QFWG1650: "Nolans Gympie",
  // Matched by kill date against the NLIS audit report's processor numbers.
  QKMC0170: "Mackay abattoir (#67)",
  QBGT7103: "Grantham abattoir (#203)",
  QKBM0095: "Teys Biloela (#399)",
  QDLI1244: "JBS Rockhampton (#384)",
};
/** Other PICs cattle came from or went to, by name. */
const PLACES: Record<string, string> = {
  QIBH0131: "Penjobe",
  QBBH0059: "The Pocket (Jim Bishop, Rolleston)",
  QJMK0252: "Julia Creek",
  QJJI0136: "Terrick Terrick, Blackall",
};
export const picName = (pic: string | null) => (pic ? PROCESSORS[pic] ?? PLACES[pic] ?? null : null);

const key = (s: string) => s.toLowerCase().replace(/_x0020_/g, "").replace(/_x002f_/g, "").replace(/[^a-z]/g, "");

function isoDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})[-.](\d{2})[-.](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

export function isNlisReport(text: string): boolean {
  const h = key(text.split(/\r?\n/, 1)[0] ?? "");
  return h.includes("rfid") && h.includes("nlisid") && (h.includes("destinationpic") || h.includes("sourcepic"));
}

export function parseNlis(text: string): NlisRow[] {
  const table = parseCsv(text);
  const head = (table[0] ?? []).map(key);
  const at = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const off = at("destinationpic") >= 0;
  const c = {
    rfid: at("rfid"), nlis: at("nlisid"), pic: off ? at("destinationpic") : at("sourcepic"),
    nvd: at("nvdwaybill"), date: off ? at("movementdate") : at("transferdate"),
  };
  if (c.rfid < 0 || c.date < 0 || c.pic < 0) throw new StockError("This doesn't look like an NLIS cattle movement report");
  const rows: NlisRow[] = [];
  for (const r of table.slice(1)) {
    const date = isoDate(r[c.date] ?? "");
    if (!date) continue;
    const nvd = (r[c.nvd] ?? "").trim();
    rows.push({
      direction: off ? "off" : "on",
      eid: normaliseEid(r[c.rfid] ?? ""),
      nlis_id: (r[c.nlis] ?? "").trim() || null,
      pic: (r[c.pic] ?? "").trim().toUpperCase() || null,
      nvd: nvd && nvd !== "-" ? nvd : null,
      date,
    });
  }
  if (!rows.length) throw new StockError("No movements found in the report");
  return rows;
}

function matchAnimals(rows: NlisRow[]) {
  const byEid = new Map<string, { id: number; status: string; mob_id: number | null; mob: string | null; tag: string | null }>();
  for (const a of allSummaries()) if (a.eid) byEid.set(a.eid, { id: a.id, status: a.status, mob_id: a.mob_id, mob: a.mob_name ?? null, tag: a.tag });
  const byNlis = new Map((db.prepare("SELECT id, nlis FROM animals WHERE nlis IS NOT NULL").all() as Array<{ id: number; nlis: string }>).map((a) => [a.nlis.toUpperCase(), a.id]));
  return rows.map((r) => {
    let a = r.eid ? byEid.get(r.eid) : undefined;
    if (!a && r.nlis_id && byNlis.has(r.nlis_id.toUpperCase())) {
      const id = byNlis.get(r.nlis_id.toUpperCase())!;
      a = [...byEid.values()].find((x) => x.id === id);
    }
    return { r, a: a ?? null };
  });
}

/** Seen here (weighed, processed) after the date NLIS has it leaving: it came back, or NLIS is wrong. */
const seenAfter = (() => {
  const q = db.prepare("SELECT 1 FROM animal_events WHERE animal_id = ? AND date > ? AND kind IN ('weigh', 'treatment', 'score', 'join') LIMIT 1");
  return (animalId: number, date: string) => !!q.get(animalId, date);
})();

const howLeft = (pic: string | null) =>
  pic === "DECEASED" ? "death" : pic && PROCESSORS[pic] ? "sale" : "gone";

export function planNlis(rows: NlisRow[]) {
  const m = matchAnimals(rows);
  const have = new Set((db.prepare("SELECT direction, eid, date, pic FROM nlis_movements").all() as Array<{ direction: string; eid: string | null; date: string; pic: string | null }>)
    .map((x) => `${x.direction}|${x.eid}|${x.date}|${x.pic}`));
  const fresh = m.filter((x) => !have.has(`${x.r.direction}|${x.r.eid}|${x.r.date}|${x.r.pic}`));
  const off = fresh.filter((x) => x.r.direction === "off");
  const back = off.filter((x) => x.a && x.a.status === "alive" && seenAfter(x.a.id, x.r.date));
  const leaving = off.filter((x) => x.a && x.a.status === "alive" && !seenAfter(x.a.id, x.r.date));
  const inMobLeaving = leaving.filter((x) => x.a!.mob_id !== null);
  const by = { death: 0, sale: 0, gone: 0 };
  for (const x of leaving) by[howLeft(x.r.pic) as keyof typeof by]++;
  const pics: Record<string, number> = {};
  for (const x of off) if (x.r.pic) pics[x.r.pic] = (pics[x.r.pic] ?? 0) + 1;
  const mobs: Record<string, number> = {};
  for (const x of inMobLeaving) mobs[x.a!.mob ?? "?"] = (mobs[x.a!.mob ?? "?"] ?? 0) + 1;
  return {
    direction: rows[0]!.direction,
    rows: rows.length,
    already: rows.length - fresh.length,
    matched: fresh.filter((x) => x.a).length,
    unmatched: fresh.filter((x) => !x.a).length,
    leaving: leaving.length,
    leaving_by: by,
    leaving_from_mobs: Object.entries(mobs).map(([name, head]) => ({ name, head })).sort((a, b) => b.head - a.head),
    already_ended: off.filter((x) => x.a && x.a.status !== "alive").length,
    seen_after: back.length,
    destinations: Object.entries(pics).map(([pic, head]) => ({ pic, head, name: picName(pic) ?? (pic === "DECEASED" ? "Recorded dead" : null) })).sort((a, b) => b.head - a.head),
    from: rows.reduce((d, r) => (r.date < d ? r.date : d), rows[0]!.date),
    to: rows.reduce((d, r) => (r.date > d ? r.date : d), rows[0]!.date),
  };
}

export function commitNlis(rows: NlisRow[], filename: string, username: string | null) {
  const plan = planNlis(rows);
  const m = matchAnimals(rows);
  const batch = randomUUID();
  const now = Date.now();
  const exists = db.prepare("SELECT 1 FROM nlis_movements WHERE direction = ? AND IFNULL(eid, '') = IFNULL(?, '') AND date = ? AND IFNULL(pic, '') = IFNULL(?, '')");
  const ins = db.prepare(`INSERT INTO nlis_movements (direction, eid, nlis_id, pic, nvd, date, animal_id, filename, batch, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let kept = 0, left = 0;
  db.transaction(() => {
    for (const { r, a } of m) {
      if (exists.get(r.direction, r.eid, r.date, r.pic)) continue;
      ins.run(r.direction, r.eid, r.nlis_id, r.pic, r.nvd, r.date, a?.id ?? null, filename, batch, now);
      kept++;
      if (r.direction !== "off" || !a || a.status !== "alive" || seenAfter(a.id, r.date)) continue;
      const how = howLeft(r.pic);
      const where = r.pic === "DECEASED" ? null : picName(r.pic) ?? r.pic;
      addAnimalEvent(a.id, {
        date: r.date, kind: how, mob_id: a.mob_id,
        text: how === "death" ? "Recorded dead in NLIS" : `Moved off to ${where ?? "an unknown PIC"} (NLIS)`,
        data: { from: "NLIS", destination: where, destination_pic: r.pic, nvd: r.nvd },
      }, "nlis", username, batch);
      left++;
      a.status = how === "sale" ? "sold" : how === "death" ? "dead" : "gone";
    }
  })();
  return {
    batch,
    summary: `NLIS ${plan.direction === "off" ? "moved-off" : "moved-on"} report: ${kept.toLocaleString("en-AU")} movements kept${left ? `, ${left.toLocaleString("en-AU")} animals recorded as having left` : ""}${plan.unmatched ? `; ${plan.unmatched.toLocaleString("en-AU")} tags not in the app` : ""}`,
  };
}

/**
 * Where NLIS and the app disagree, for cleaning up the NLIS record (or the
 * app's): tags NLIS holds here that the app shows as gone, tags it holds that
 * the app doesn't know at all, and animals on hand here that NLIS says left.
 */
export function nlisCheck() {
  const animals = new Map(allSummaries().filter((a) => a.eid).map((a) => [a.eid!, a]));
  const on = db.prepare("SELECT * FROM nlis_movements WHERE direction = 'on'").all() as Array<{ eid: string | null; nlis_id: string | null; pic: string | null; date: string }>;
  const offEids = new Set((db.prepare("SELECT eid FROM nlis_movements WHERE direction = 'off' AND eid IS NOT NULL").all() as Array<{ eid: string }>).map((r) => r.eid));
  const lastSeen = db.prepare("SELECT MAX(date) d FROM animal_events WHERE animal_id = ? AND kind IN ('weigh', 'treatment', 'score', 'note')");
  const ended = [], unknown = [], noMob = [];
  for (const r of on) {
    if (r.eid && offEids.has(r.eid)) continue;
    const a = r.eid ? animals.get(r.eid) : undefined;
    const row = { eid: r.eid, nlis_id: r.nlis_id, from_pic: r.pic, arrived: r.date };
    if (!a) unknown.push(row);
    else if (a.status !== "alive") ended.push({ ...row, tag: a.tag, app_status: a.status, last_seen: (lastSeen.get(a.id) as { d: string | null }).d });
    else if (a.mob_id === null) noMob.push({ ...row, tag: a.tag, last_seen: (lastSeen.get(a.id) as { d: string | null }).d });
  }
  const conflicts = (db.prepare(`
    SELECT n.eid, n.pic, n.date FROM nlis_movements n WHERE n.direction = 'off' AND n.eid IS NOT NULL
  `).all() as Array<{ eid: string; pic: string; date: string }>)
    .filter((r) => { const a = animals.get(r.eid); return a && a.status === "alive" && a.mob_id !== null; })
    .map((r) => { const a = animals.get(r.eid)!; return { eid: r.eid, tag: a.tag, mob: a.mob_name, to_pic: r.pic, date: r.date }; });
  return { reports: db.prepare("SELECT direction, COUNT(*) n, MIN(date) from_date, MAX(date) to_date FROM nlis_movements GROUP BY direction").all(), ended, unknown, no_mob: noMob, conflicts };
}
