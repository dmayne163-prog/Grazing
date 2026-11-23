/**
 * Feed checks: what you see in a paddock while driving past, as a quick rating
 * ("eaten down", "getting short", "fair", "plenty") or a kg/ha estimate. The
 * pasture model starts the paddock from the newest check when it's newer than
 * the last Cibo reading, so the Rotation tab follows what's on the ground
 * between readings. A newer Cibo reading takes over again.
 */
import { db, getSetting } from "../db/database.js";
import { today } from "../stock/store.js";

export type Rating = "eaten" | "short" | "fair" | "plenty";

/** Each rating as a share of the paddock's floor (its own, or the farm's rule). */
export const RATINGS: Record<Rating, { label: string; factor: number }> = {
  eaten: { label: "Eaten down", factor: 0.9 },
  short: { label: "Getting short", factor: 1.3 },
  fair: { label: "Fair", factor: 2 },
  plenty: { label: "Plenty", factor: 3 },
};

export interface FeedCheck {
  id: number;
  feature_id: number;
  checked_on: string;     // YYYY-MM-DD
  rating: Rating | null;  // null: a kg/ha estimate on its own
  kg_ha: number;          // what the model starts from
  note: string | null;
  username: string | null;
  created_at: number;
}

export class FeedCheckError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const round50 = (n: number) => Math.round(n / 50) * 50;

/** The paddock's floor: its own "leave at least", else the farm's rule. */
export function floorOf(featureId: number): number {
  const r = db.prepare("SELECT props FROM features WHERE id = ?").get(featureId) as { props: string | null } | undefined;
  let own = NaN;
  try { own = Number((JSON.parse(r?.props || "{}") as Record<string, unknown>)["residual_kg_ha"]); } catch { /* none */ }
  if (Number.isFinite(own) && own > 0) return own;
  // The farm's rule, as the planner keeps it (src/pasture/plan.ts planRules).
  let rule: number | undefined;
  try { rule = (JSON.parse(getSetting("plan_rules") || "{}") as { residual?: number }).residual; } catch { /* default */ }
  return rule ?? 1200;
}

/** What each rating stands for in this paddock, kg/ha. */
export function scaleFor(featureId: number): Record<Rating, number> {
  const floor = floorOf(featureId);
  const out = {} as Record<Rating, number>;
  for (const [k, v] of Object.entries(RATINGS)) out[k as Rating] = round50(floor * v.factor);
  return out;
}

export function listChecks(featureId: number): FeedCheck[] {
  return db.prepare("SELECT id, feature_id, checked_on, rating, kg_ha, note, username, created_at FROM feed_checks WHERE feature_id = ? AND deleted_at IS NULL ORDER BY checked_on DESC, id DESC")
    .all(featureId) as FeedCheck[];
}

/** Each paddock's newest check: the one the model can use. */
export function latestChecks(): Map<number, FeedCheck> {
  const out = new Map<number, FeedCheck>();
  for (const c of db.prepare("SELECT id, feature_id, checked_on, rating, kg_ha, note, username, created_at FROM feed_checks WHERE deleted_at IS NULL ORDER BY checked_on DESC, id DESC").all() as FeedCheck[]) {
    if (!out.has(c.feature_id)) out.set(c.feature_id, c);
  }
  return out;
}

/** Changes whenever a check is added or removed: part of the plan's and outlook's cache keys. */
export function checksStamp(): string {
  const r = db.prepare("SELECT COUNT(*) AS n, IFNULL(MAX(id), 0) AS i, IFNULL(MAX(deleted_at), 0) AS d FROM feed_checks").get() as { n: number; i: number; d: number };
  return `${r.n}:${r.i}:${r.d}`;
}

export function addCheck(featureId: number, b: Record<string, unknown>, who: string | null): FeedCheck {
  const f = db.prepare("SELECT kind FROM features WHERE id = ? AND deleted_at IS NULL").get(featureId) as { kind: string } | undefined;
  if (f?.kind !== "paddock") throw new FeedCheckError("A feed check goes on a paddock");
  const day = b["checked_on"] === undefined || b["checked_on"] === "" ? today() : b["checked_on"];
  if (!isDay(day)) throw new FeedCheckError("Give the day you checked it");
  if (Date.parse(`${day}T00:00:00Z`) > Date.now() + 86_400_000) throw new FeedCheckError("The check can't be in the future");
  const rating = b["rating"] === undefined || b["rating"] === null || b["rating"] === "" ? null : String(b["rating"]);
  if (rating !== null && !(rating in RATINGS)) throw new FeedCheckError("Pick how much feed there is");
  let kg: number | null = null;
  if (b["kg_ha"] !== undefined && b["kg_ha"] !== null && b["kg_ha"] !== "") {
    kg = Number(b["kg_ha"]);
    if (!Number.isFinite(kg) || kg < 50 || kg > 15000) throw new FeedCheckError("kg/ha: between 50 and 15,000");
  }
  if (kg === null && rating === null) throw new FeedCheckError("Pick how much feed there is, or give a kg/ha");
  if (kg === null) kg = scaleFor(featureId)[rating as Rating];
  const note = typeof b["note"] === "string" && b["note"].trim() ? b["note"].trim().slice(0, 500) : null;
  const r = db.prepare("INSERT INTO feed_checks (feature_id, checked_on, rating, kg_ha, note, username, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(featureId, day, rating, Math.round(kg), note, who, Date.now());
  return getCheck(Number(r.lastInsertRowid))!;
}

export function getCheck(id: number): FeedCheck | null {
  return (db.prepare("SELECT id, feature_id, checked_on, rating, kg_ha, note, username, created_at FROM feed_checks WHERE id = ? AND deleted_at IS NULL").get(id) as FeedCheck | undefined) ?? null;
}

/** Removes a check from view; the row is kept. */
export function deleteCheck(id: number): boolean {
  return db.prepare("UPDATE feed_checks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), id).changes > 0;
}
