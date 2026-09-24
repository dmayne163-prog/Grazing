/**
 * Rainfall: gauges and the readings taken from them.
 *
 * The property's own gauge records are the primary record. SILO fills gaps
 * before 2020 only and is otherwise a comparison series — never merged in —
 * which is why readings carry their source.
 */
import { db } from "../db/database.js";

export class RainError extends Error {}

export interface GaugeRow {
  id: number;
  name: string;
  feature_id: number | null;
  notes: string | null;
  created_at: number;
}

export interface ReadingRow {
  id: number;
  gauge_id: number;
  date: string;
  time: string | null;
  mm: number;
  note: string | null;
  source: string;
  username: string | null;
  created_at: number;
}

export function listGauges(): GaugeRow[] {
  return db.prepare("SELECT * FROM rain_gauges ORDER BY name COLLATE NOCASE").all() as GaugeRow[];
}

export function gaugeByName(name: string): GaugeRow | null {
  return (db.prepare("SELECT * FROM rain_gauges WHERE name = ?").get(name) as GaugeRow | undefined) ?? null;
}

export function ensureGauge(name: string): number {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new RainError("A gauge needs a name");
  const g = gaugeByName(clean);
  if (g) return g.id;
  return Number(db.prepare("INSERT INTO rain_gauges (name, created_at) VALUES (?, ?)").run(clean, Date.now()).lastInsertRowid);
}

export function renameGauge(id: number, name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new RainError("A gauge needs a name");
  const other = gaugeByName(clean);
  if (other && other.id !== id) throw new RainError(`There is already a gauge called "${clean}"`);
  db.prepare("UPDATE rain_gauges SET name = ? WHERE id = ?").run(clean, id);
}

export function listReadings(): ReadingRow[] {
  return db.prepare("SELECT * FROM rain_readings ORDER BY date DESC, time DESC, id DESC").all() as ReadingRow[];
}

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** Whether this exact reading is already recorded — the re-import guard. */
export function readingExists(gaugeId: number, date: string, time: string | null, mm: number): boolean {
  return !!db.prepare(
    "SELECT 1 FROM rain_readings WHERE gauge_id = ? AND date = ? AND IFNULL(time, '') = IFNULL(?, '') AND mm = ?"
  ).get(gaugeId, date, time, mm);
}

export function addReading(
  gaugeId: number, date: string, time: string | null, mm: number, note: string | null,
  source: string, username: string | null
): number {
  if (!isDate(date)) throw new RainError("Give the date as YYYY-MM-DD");
  if (!Number.isFinite(mm) || mm < 0 || mm > 1000) throw new RainError("Rainfall must be between 0 and 1000 mm");
  if (!db.prepare("SELECT 1 FROM rain_gauges WHERE id = ?").get(gaugeId)) throw new RainError("No such gauge");
  return Number(db.prepare(`
    INSERT INTO rain_readings (gauge_id, date, time, mm, note, source, username, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gaugeId, date, time, Math.round(mm * 10) / 10, note, source, username, Date.now()).lastInsertRowid);
}

export function deleteReading(id: number): boolean {
  return db.prepare("DELETE FROM rain_readings WHERE id = ?").run(id).changes > 0;
}
