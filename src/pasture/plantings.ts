/**
 * Plantings on the cultivation paddocks: when a crop went in, what it was, the
 * seeding and fertiliser rates, and when it'll be ready to graze. The rotation
 * planner leaves a paddock out until its newest planting is ready.
 */
import { db } from "../db/database.js";

export interface Planting {
  id: number;
  feature_id: number;
  sown_on: string;            // YYYY-MM-DD
  crop: string;
  rate_kg_ha: number | null;  // seed
  fertiliser: string | null;  // e.g. "Urea 50 kg/ha"
  ready_on: string | null;    // ready to graze from
  note: string | null;
  username: string | null;
  created_at: number;
  updated_at: number;
}

export class PlantingError extends Error {}

/** A first guess at the time to grazing, if none is given: about 8 weeks for a forage crop. */
export const DEFAULT_READY_DAYS = 56;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function listPlantings(featureId?: number): Planting[] {
  return (featureId === undefined
    ? db.prepare("SELECT * FROM plantings WHERE deleted_at IS NULL ORDER BY sown_on DESC, id DESC").all()
    : db.prepare("SELECT * FROM plantings WHERE deleted_at IS NULL AND feature_id = ? ORDER BY sown_on DESC, id DESC").all(featureId)) as Planting[];
}

/** Each paddock's newest planting (the one that counts for grazing). */
export function latestPlantings(): Map<number, Planting> {
  const out = new Map<number, Planting>();
  for (const p of listPlantings()) if (!out.has(p.feature_id)) out.set(p.feature_id, p);
  return out;
}

/** Checks and tidies what the form sent. Anything not sent keeps its old value on an edit. */
export function cleanPlanting(b: Record<string, unknown>, old?: Planting) {
  const sown = b["sown_on"] === undefined && old ? old.sown_on : b["sown_on"];
  if (!isDay(sown)) throw new PlantingError("Give the date it was planted");
  const crop = b["crop"] === undefined && old ? old.crop : text(b["crop"], 80);
  if (!crop) throw new PlantingError("Say what was planted, e.g. Oats");
  let rate = old?.rate_kg_ha ?? null;
  if (b["rate_kg_ha"] !== undefined) {
    rate = b["rate_kg_ha"] === null || b["rate_kg_ha"] === "" ? null : Number(b["rate_kg_ha"]);
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0 || rate > 1000)) throw new PlantingError("Seeding rate: kg/ha, or leave it blank");
  }
  let ready = b["ready_on"] === undefined && old ? old.ready_on : (b["ready_on"] === "" || b["ready_on"] == null ? null : b["ready_on"]);
  if (ready !== null && !isDay(ready)) throw new PlantingError("Ready to graze: a date, or leave it blank");
  if (ready !== null && ready < sown) throw new PlantingError("It can't be ready to graze before it was planted");
  return {
    sown_on: sown, crop, rate_kg_ha: rate, ready_on: ready as string | null,
    fertiliser: b["fertiliser"] === undefined && old ? old.fertiliser : text(b["fertiliser"], 120),
    note: b["note"] === undefined && old ? old.note : text(b["note"], 1000),
  };
}

export function addPlanting(featureId: number, b: Record<string, unknown>, who: string | null): number {
  const f = db.prepare("SELECT kind FROM features WHERE id = ? AND deleted_at IS NULL").get(featureId) as { kind: string } | undefined;
  if (f?.kind !== "paddock") throw new PlantingError("Plantings go on a paddock");
  const c = cleanPlanting(b);
  const now = Date.now();
  const r = db.prepare(`INSERT INTO plantings (feature_id, sown_on, crop, rate_kg_ha, fertiliser, ready_on, note, username, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(featureId, c.sown_on, c.crop, c.rate_kg_ha, c.fertiliser, c.ready_on, c.note, who, now, now);
  return Number(r.lastInsertRowid);
}

export function getPlanting(id: number): Planting | null {
  return (db.prepare("SELECT * FROM plantings WHERE id = ? AND deleted_at IS NULL").get(id) as Planting | undefined) ?? null;
}

export function updatePlanting(id: number, b: Record<string, unknown>): Planting {
  const old = getPlanting(id);
  if (!old) throw new PlantingError("That planting doesn't exist any more");
  const c = cleanPlanting(b, old);
  db.prepare(`UPDATE plantings SET sown_on = ?, crop = ?, rate_kg_ha = ?, fertiliser = ?, ready_on = ?, note = ?, updated_at = ? WHERE id = ?`)
    .run(c.sown_on, c.crop, c.rate_kg_ha, c.fertiliser, c.ready_on, c.note, Date.now(), id);
  return getPlanting(id)!;
}

/** Removes a planting from view; the row is kept. */
export function deletePlanting(id: number): boolean {
  return db.prepare("UPDATE plantings SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), id).changes > 0;
}
