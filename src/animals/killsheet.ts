/**
 * Kill sheets: the processor's assessment sheet and invoice (Hewitt Foods
 * sends one per consignment, as .xlsx or .csv), one row per carcase with its
 * ear tag (EID), hot standard carcase weight and grading.
 *
 * Read by column heading, so no judgement is involved: each carcase is matched
 * to its animal by EID, the animal is recorded as sold with its carcase on its
 * record, the sale comes off the mobs it left (unless the mob history already
 * has that sale), and the dressing percentage is worked out wherever the
 * animal was weighed alive shortly before. The whole sheet is kept, matched or
 * not, for the Ruminati production figures and for audits.
 */
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { db } from "../db/database.js";
import { addEvent as addMobEvent, mobViews } from "../stock/store.js";
import { StockError } from "../stock/actions.js";
import { normaliseEid, parseCsv } from "./session.js";
import { addAnimalEvent, currentMob, eventsOf, statusOf } from "./store.js";

export interface KillRow {
  body: string | null;
  sex: string | null;
  teeth: number | null;
  fat_mm: number | null;
  hscw_kg: number;
  eid: string | null;
  msa_index: number | null;
  price_per_kg: number | null;
  value: number | null;
  /** Every other column, by its heading: marbling, colours, EMA, ossification… */
  grading: Record<string, string | number>;
}

export interface KillSheet {
  invoice: string | null;
  date: string | null;
  plant: string | null;
  pic: string | null;
  vendor: string | null;
  rows: KillRow[];
}

/** A weight taken this long before the kill still counts for the dressing percentage. */
const DRESSING_WINDOW_DAYS = 30;

const key = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9$%]/g, "");
const num = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
};

/** "28-08-2025", "28/07/2026", "2025-08-28" or a spreadsheet date → "2025-08-28". */
function isoDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return null;
}

/** Plain cell values from a workbook's first sheet, as a grid like a CSV's. */
async function xlsxGrid(buf: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, i) => {
    const vals = Array.from(row.values as unknown[]).slice(1).map((c) => {
      if (c && typeof c === "object" && !(c instanceof Date)) {
        const o = c as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
        if (o.result !== undefined) return o.result;
        if (o.richText) return o.richText.map((t) => t.text).join("");
        if (o.text !== undefined) return o.text;
      }
      return c;
    });
    out[i - 1] = vals;
  });
  return out.map((r) => r ?? []);
}

/** The header row of carcases: it has the carcase weight and the body number. */
const isHeader = (r: unknown[]) => r.some((c) => key(c).startsWith("hscw")) && r.some((c) => key(c).startsWith("body"));

/** Whether a file is a kill sheet, from a look at its first rows. */
export async function isKillSheet(filename: string, buf: Buffer): Promise<boolean> {
  try {
    const grid = /\.xlsx$/i.test(filename) ? await xlsxGrid(buf) : parseCsv(buf.toString("utf8", 0, 20_000));
    return grid.slice(0, 30).some(isHeader);
  } catch {
    return false;
  }
}

export async function parseKillSheet(filename: string, buf: Buffer): Promise<KillSheet> {
  const grid = /\.xlsx$/i.test(filename) ? await xlsxGrid(buf) : parseCsv(buf.toString("utf8"));
  const h = grid.findIndex(isHeader);
  if (h < 0) throw new StockError("No carcase table found (a header row with BODY NO. and HSCW)");

  // The details above the table: a label cell, its value in the next filled cell.
  const after = (label: RegExp) => {
    for (const r of grid.slice(0, h)) {
      for (let j = 0; j < r.length; j++) {
        if (label.test(String(r[j] ?? ""))) {
          for (let k = j + 1; k < r.length; k++) if (String(r[k] ?? "").trim()) return r[k];
        }
      }
    }
    return null;
  };
  const plantRow = grid.slice(0, h).findIndex((r) => r.some((c) => /^\s*PLANT:?\s*$/i.test(String(c ?? ""))));
  const plantCol = plantRow >= 0 ? grid[plantRow]!.findIndex((c) => /^\s*PLANT:?\s*$/i.test(String(c ?? ""))) : -1;
  const plantBelow = plantRow >= 0 ? String(grid[plantRow + 1]?.[plantCol] || grid[plantRow + 2]?.[plantCol] || "").trim() : "";

  const head = grid[h]!.map(key);
  const col = (...names: string[]) => head.findIndex((c) => names.some((n) => c.startsWith(n)));
  const at = {
    body: col("bodyno", "body"), sex: col("sex"), teeth: col("teeth", "dentition"), fat: col("fatmm", "p8"),
    hscw: col("hscw"), eid: col("eartag", "eid", "nlis"), msa: col("msaindex"), price: col("$kg", "pricekg"), value: col("value$", "value"),
  };
  if (at.hscw < 0) throw new StockError("The carcase table has no HSCW column");
  const used = new Set(Object.values(at).filter((j) => j >= 0));

  const rows: KillRow[] = [];
  for (const r of grid.slice(h + 1)) {
    // A totals line ends the table.
    if (r.some((c) => /^\s*(grand\s+)?totals?\b/i.test(String(c ?? "")))) break;
    const hscw = num(r[at.hscw]);
    // The table ends at the first row without a carcase weight and a body or tag (the totals).
    if (hscw === null || hscw <= 0 || (at.body >= 0 && num(r[at.body]) === null && (at.eid < 0 || !normaliseEid(String(r[at.eid] ?? ""))))) {
      if (rows.length) break;
      continue;
    }
    const grading: Record<string, string | number> = {};
    grid[h]!.forEach((name, j) => {
      const v = r[j];
      if (used.has(j) || v === null || v === undefined || String(v).trim() === "" || !String(name ?? "").trim()) return;
      grading[String(name).replace(/\s+/g, " ").trim()] = typeof v === "number" ? v : String(v).trim();
    });
    rows.push({
      body: at.body >= 0 ? String(r[at.body] ?? "").trim() || null : null,
      sex: at.sex >= 0 ? String(r[at.sex] ?? "").trim() || null : null,
      teeth: at.teeth >= 0 ? num(r[at.teeth]) : null,
      fat_mm: at.fat >= 0 ? num(r[at.fat]) : null,
      hscw_kg: Math.round(hscw * 10) / 10,
      eid: at.eid >= 0 ? normaliseEid(String(r[at.eid] ?? "")) : null,
      msa_index: at.msa >= 0 ? num(r[at.msa]) : null,
      price_per_kg: at.price >= 0 ? num(r[at.price]) : null,
      value: at.value >= 0 ? (num(r[at.value]) === null ? null : Math.round(num(r[at.value])! * 100) / 100) : null,
      grading,
    });
  }
  if (!rows.length) throw new StockError("No carcases found under the header row");
  const inv = String(after(/invoice\s*#?/i) ?? "").replace(/\s+/g, "").trim();
  return {
    invoice: inv || null,
    date: isoDate(after(/processing date|kill date|^\s*date:?\s*$/i)),
    plant: plantBelow || null,
    pic: String(after(/^\s*PIC:?\s*$/i) ?? "").trim() || null,
    vendor: String(after(/^\s*VENDOR:?\s*$/i) ?? "").trim() || null,
    rows,
  };
}

const shift = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

interface Matched { i: number; animal_id: number; tag: string | null; status: string; mob_id: number | null; live_kg: number | null; weighed: string | null; dressing: number | null }

function match(s: KillSheet, killDate: string) {
  const byEid = db.prepare("SELECT id, tag FROM animals WHERE eid = ?");
  const matched: Matched[] = [];
  const unmatched: number[] = [];
  s.rows.forEach((r, i) => {
    const a = r.eid ? byEid.get(r.eid) as { id: number; tag: string | null } | undefined : undefined;
    if (!a) { unmatched.push(i); return; }
    const ev = eventsOf(a.id).filter((e) => e.date <= killDate);
    const w = ev.filter((e) => e.kind === "weigh" && e.weight_kg !== null && e.date >= shift(killDate, -DRESSING_WINDOW_DAYS)).at(-1);
    matched.push({
      i, animal_id: a.id, tag: a.tag, status: statusOf(eventsOf(a.id)).status, mob_id: currentMob(ev),
      live_kg: w?.weight_kg ?? null, weighed: w?.date ?? null,
      dressing: w?.weight_kg ? Math.round((r.hscw_kg / w.weight_kg) * 1000) / 10 : null,
    });
  });
  return { matched, unmatched };
}

/** What importing the sheet would do, for checking before anything is recorded. */
export function planKillSheet(s: KillSheet) {
  if (!s.date) throw new StockError("The kill sheet has no processing date");
  const dupe = s.invoice ? db.prepare("SELECT date, filename FROM kill_sheets WHERE invoice = ?").get(s.invoice) as { date: string; filename: string } | undefined : undefined;
  const { matched, unmatched } = match(s, s.date);
  const mobs = new Map<number, number>();
  for (const m of matched) if (m.mob_id !== null && m.status === "alive") mobs.set(m.mob_id, (mobs.get(m.mob_id) ?? 0) + 1);
  const mobName = (id: number) => (db.prepare("SELECT name FROM mobs WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? `mob #${id}`;
  // A sale already in the mob's history near the kill (from AgriWebb, or entered by hand).
  const recorded = (id: number) => db.prepare(`
    SELECT date, -SUM(head_change) head FROM mob_events
    WHERE mob_id = ? AND kind = 'sale' AND date BETWEEN ? AND ? GROUP BY date ORDER BY date
  `).all(id, shift(s.date!, -14), shift(s.date!, 7)) as Array<{ date: string; head: number }>;
  const dress = matched.filter((m) => m.dressing !== null);
  const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
  const bySex = new Map<string, { head: number; hscw: number }>();
  for (const r of s.rows) {
    const k = r.sex ?? "?";
    const g = bySex.get(k) ?? { head: 0, hscw: 0 };
    g.head++; g.hscw += r.hscw_kg;
    bySex.set(k, g);
  }
  return {
    invoice: s.invoice, date: s.date, plant: s.plant, vendor: s.vendor, pic: s.pic,
    head: s.rows.length, hscw_kg: Math.round(sum(s.rows.map((r) => r.hscw_kg)) * 10) / 10,
    value: Math.round(sum(s.rows.map((r) => r.value ?? 0)) * 100) / 100,
    by_sex: [...bySex].map(([sex, g]) => ({ sex, head: g.head, hscw_kg: Math.round(g.hscw * 10) / 10 })),
    duplicate: dupe ? `Invoice ${s.invoice} was already imported (${dupe.filename})` : null,
    matched: matched.length,
    already_sold: matched.filter((m) => m.status !== "alive").length,
    unmatched: unmatched.length,
    unmatched_eids: unmatched.map((i) => s.rows[i]!.eid).filter(Boolean).slice(0, 20),
    mobs: [...mobs].map(([id, head]) => {
      const prior = recorded(id);
      return { id, name: mobName(id), head, recorded: prior, take_off: !prior.some((p) => p.head > 0) };
    }),
    dressing: dress.length ? {
      animals: dress.length,
      average: Math.round((sum(dress.map((m) => m.dressing!)) / dress.length) * 10) / 10,
      min: Math.min(...dress.map((m) => m.dressing!)), max: Math.max(...dress.map((m) => m.dressing!)),
    } : null,
  };
}

export function commitKillSheet(
  s: KillSheet, filename: string,
  opts: { left_date?: unknown; take_off?: unknown; unmatched_mob_id?: unknown },
  username: string | null,
) {
  const plan = planKillSheet(s);
  if (plan.duplicate) throw new StockError(plan.duplicate);
  const left = isoDate(opts.left_date) ?? s.date!;
  if (left > s.date!) throw new StockError("They can't leave after the kill date");
  const takeOff = new Set(Array.isArray(opts.take_off) ? opts.take_off.map(Number) : []);
  const unmatchedMob = opts.unmatched_mob_id ? Number(opts.unmatched_mob_id) : null;
  if (unmatchedMob !== null && !db.prepare("SELECT 1 FROM mobs WHERE id = ?").get(unmatchedMob)) throw new StockError("No such mob");
  const batch = randomUUID();
  const now = Date.now();
  const { matched, unmatched } = match(s, s.date!);
  const label = `${s.invoice ?? filename}${s.plant ? `, ${s.plant}` : ""}`;

  return db.transaction(() => {
    const sheet = Number(db.prepare(`
      INSERT INTO kill_sheets (invoice, date, left_date, plant, pic, vendor, filename, head, hscw_kg, value, batch, username, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.invoice, s.date, left, s.plant, s.pic, s.vendor, filename, plan.head, plan.hscw_kg, plan.value, batch, username, now).lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO kill_sheet_rows (sheet_id, body, animal_id, eid, sex, teeth, fat_mm, hscw_kg, msa_index, price_per_kg, value, live_kg, dressing_pct, grading, batch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const byRow = new Map(matched.map((m) => [m.i, m]));
    s.rows.forEach((r, i) => {
      const m = byRow.get(i);
      ins.run(sheet, r.body, m?.animal_id ?? null, r.eid, r.sex, r.teeth, r.fat_mm, r.hscw_kg, r.msa_index, r.price_per_kg, r.value,
        m?.live_kg ?? null, m?.dressing ?? null, JSON.stringify(r.grading), batch);
    });

    // Each animal still on hand is recorded as sold, its carcase with it.
    let sold = 0;
    const leaving = new Map<number, number>();
    for (const m of matched) {
      if (m.status !== "alive") continue;
      const r = s.rows[m.i]!;
      addAnimalEvent(m.animal_id, {
        date: left, kind: "sale", mob_id: m.mob_id,
        data: { destination: s.plant, invoice: s.invoice, body: r.body, hscw_kg: r.hscw_kg, kill_date: s.date, ...(m.dressing !== null ? { dressing_pct: m.dressing } : {}) },
      }, `killsheet:${sheet}`, username, batch);
      sold++;
      if (m.mob_id !== null) leaving.set(m.mob_id, (leaving.get(m.mob_id) ?? 0) + 1);
    }
    if (unmatchedMob !== null && unmatched.length) leaving.set(unmatchedMob, (leaving.get(unmatchedMob) ?? 0) + unmatched.length);

    // The sale off each mob ticked, unless its history already has it.
    let offMobs = 0;
    const onHand = new Map(mobViews(left).map((v) => [v.mob.id, v]));
    for (const [mobId, head] of leaving) {
      if (!takeOff.has(mobId) && mobId !== unmatchedMob) continue;
      const v = onHand.get(mobId);
      if (!v || v.state.head < head) {
        throw new StockError(`${v?.mob.name ?? "That mob"} had ${v?.state.head ?? 0} hd on ${left}, fewer than the ${head} leaving. Check the mob or the date.`);
      }
      addMobEvent(mobId, {
        date: left, kind: "sale", head_change: -head,
        data: { destination: s.plant ?? undefined, invoice: s.invoice, note: `Kill sheet ${label}: ${head} hd, processed ${s.date}` },
      }, "app", username, batch);
      offMobs += head;
    }
    return {
      batch,
      summary: `kill sheet ${label}: ${plan.head} carcases, ${plan.hscw_kg.toLocaleString("en-AU")} kg HSCW; ${sold} animal${sold === 1 ? "" : "s"} recorded sold${offMobs ? `, ${offMobs} hd taken off mobs` : ""}${unmatched.length ? `; ${unmatched.length} not matched to an animal` : ""}`,
    };
  })();
}

/** Every kill sheet in a span: head, carcase and estimated live weight, for Ruminati's production page. */
export function killSheetTotals(from: string, to: string) {
  const sheets = db.prepare("SELECT * FROM kill_sheets WHERE date BETWEEN ? AND ? ORDER BY date").all(from, to) as Array<{ id: number; invoice: string | null; date: string; plant: string | null; head: number; hscw_kg: number; value: number }>;
  const rows = db.prepare("SELECT sheet_id, sex, teeth, hscw_kg, dressing_pct FROM kill_sheet_rows WHERE sheet_id IN (SELECT id FROM kill_sheets WHERE date BETWEEN ? AND ?)").all(from, to) as Array<{ sheet_id: number; sex: string | null; teeth: number | null; hscw_kg: number; dressing_pct: number | null }>;
  return { sheets, rows };
}
