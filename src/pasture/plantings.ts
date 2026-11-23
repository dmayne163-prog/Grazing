/**
 * Plantings on the cultivation paddocks: when it went in, the crops in the mix
 * (each with its own seeding rate), the fertiliser, and when it'll be ready to
 * graze. The rotation planner leaves a paddock out until its newest planting
 * is ready.
 */
import { db } from "../db/database.js";

export interface CropSown { crop: string; rate_kg_ha: number | null }

export interface Planting {
  id: number;
  feature_id: number;
  sown_on: string;            // YYYY-MM-DD
  /** The crops in the mix, each with its seeding rate. */
  crops: CropSown[];
  crop: string;               // their names joined, "Oats + Vetch"
  rate_kg_ha: number | null;  // the total seeding rate, when every crop has one
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
const MAX_CROPS = 8;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

type Row = Omit<Planting, "crops"> & { crops: string | null };

/** Rows from before mixes were recorded have one crop, in crop and rate_kg_ha. */
function fromRow(r: Row): Planting {
  let crops: CropSown[] | null = null;
  try { crops = r.crops ? (JSON.parse(r.crops) as CropSown[]) : null; } catch { crops = null; }
  return { ...r, crops: crops?.length ? crops : [{ crop: r.crop, rate_kg_ha: r.rate_kg_ha }] };
}

export function listPlantings(featureId?: number): Planting[] {
  return ((featureId === undefined
    ? db.prepare("SELECT * FROM plantings WHERE deleted_at IS NULL ORDER BY sown_on DESC, id DESC").all()
    : db.prepare("SELECT * FROM plantings WHERE deleted_at IS NULL AND feature_id = ? ORDER BY sown_on DESC, id DESC").all(featureId)) as Row[]).map(fromRow);
}

/** Each paddock's newest planting (the one that counts for grazing). */
export function latestPlantings(): Map<number, Planting> {
  const out = new Map<number, Planting>();
  for (const p of listPlantings()) if (!out.has(p.feature_id)) out.set(p.feature_id, p);
  return out;
}

function cleanRate(v: unknown, crop: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new PlantingError(`Seeding rate for ${crop}: kg/ha, or leave it blank`);
  return Math.round(n * 100) / 100;
}

/** The crops sent: a list of {crop, rate_kg_ha}, or one crop as crop and rate_kg_ha. */
function cleanCrops(b: Record<string, unknown>): CropSown[] | null {
  if (Array.isArray(b["crops"])) {
    const out: CropSown[] = [];
    for (const c of b["crops"] as Array<Record<string, unknown>>) {
      const crop = text(c?.["crop"], 60);
      if (!crop) { if (c?.["rate_kg_ha"] !== undefined && c["rate_kg_ha"] !== null && c["rate_kg_ha"] !== "") throw new PlantingError("Each seeding rate needs the crop it's for"); continue; }
      out.push({ crop, rate_kg_ha: cleanRate(c["rate_kg_ha"], crop) });
    }
    if (out.length > MAX_CROPS) throw new PlantingError(`Up to ${MAX_CROPS} crops in a planting`);
    return out;
  }
  if (b["crop"] === undefined) return null;
  const crop = text(b["crop"], 60);
  return crop ? [{ crop, rate_kg_ha: cleanRate(b["rate_kg_ha"], crop) }] : [];
}

/** Checks and tidies what the form sent. Anything not sent keeps its old value on an edit. */
export function cleanPlanting(b: Record<string, unknown>, old?: Planting) {
  const sown = b["sown_on"] === undefined && old ? old.sown_on : b["sown_on"];
  if (!isDay(sown)) throw new PlantingError("Give the date it was planted");
  const crops = cleanCrops(b) ?? old?.crops ?? [];
  if (!crops.length) throw new PlantingError("Say what was planted, e.g. Oats");
  let ready = b["ready_on"] === undefined && old ? old.ready_on : (b["ready_on"] === "" || b["ready_on"] == null ? null : b["ready_on"]);
  if (ready !== null && !isDay(ready)) throw new PlantingError("Ready to graze: a date, or leave it blank");
  if (ready !== null && ready < sown) throw new PlantingError("It can't be ready to graze before it was planted");
  return {
    sown_on: sown, crops, ready_on: ready as string | null,
    crop: crops.map((c) => c.crop).join(" + ").slice(0, 200),
    rate_kg_ha: crops.every((c) => c.rate_kg_ha !== null) ? Math.round(crops.reduce((t, c) => t + c.rate_kg_ha!, 0) * 100) / 100 : null,
    fertiliser: b["fertiliser"] === undefined && old ? old.fertiliser : text(b["fertiliser"], 120),
    note: b["note"] === undefined && old ? old.note : text(b["note"], 1000),
  };
}

export function addPlanting(featureId: number, b: Record<string, unknown>, who: string | null): number {
  const f = db.prepare("SELECT kind FROM features WHERE id = ? AND deleted_at IS NULL").get(featureId) as { kind: string } | undefined;
  if (f?.kind !== "paddock") throw new PlantingError("Plantings go on a paddock");
  const c = cleanPlanting(b);
  const now = Date.now();
  const r = db.prepare(`INSERT INTO plantings (feature_id, sown_on, crop, crops, rate_kg_ha, fertiliser, ready_on, note, username, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(featureId, c.sown_on, c.crop, JSON.stringify(c.crops), c.rate_kg_ha, c.fertiliser, c.ready_on, c.note, who, now, now);
  return Number(r.lastInsertRowid);
}

export function getPlanting(id: number): Planting | null {
  const r = db.prepare("SELECT * FROM plantings WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function updatePlanting(id: number, b: Record<string, unknown>): Planting {
  const old = getPlanting(id);
  if (!old) throw new PlantingError("That planting doesn't exist any more");
  const c = cleanPlanting(b, old);
  db.prepare(`UPDATE plantings SET sown_on = ?, crop = ?, crops = ?, rate_kg_ha = ?, fertiliser = ?, ready_on = ?, note = ?, updated_at = ? WHERE id = ?`)
    .run(c.sown_on, c.crop, JSON.stringify(c.crops), c.rate_kg_ha, c.fertiliser, c.ready_on, c.note, Date.now(), id);
  return getPlanting(id)!;
}

/** Removes a planting from view; the row is kept. */
export function deletePlanting(id: number): boolean {
  return db.prepare("UPDATE plantings SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), id).changes > 0;
}
