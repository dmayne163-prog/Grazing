/**
 * Gates: which two paddocks each one joins, and whether it is open.
 *
 * A gate is a point on the map, so the paddocks it joins are worked out from
 * where it sits: the two paddocks whose boundaries pass closest to it. Gates
 * imported from AgriWebb were placed by hand on a phone and are rarely exactly
 * on the fence, hence the tolerance — and hence the pair can be set by hand,
 * which then wins.
 */
import type { MultiPolygon, Polygon, Position } from "geojson";
import { db } from "../db/database.js";
import { listFeatures, type FeatureRow } from "./store.js";

/** How far from a boundary a gate can be and still count as on it. */
const MAX_METRES = 80;

function toLocal(lon0: number, lat0: number) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320;
  const ky = 110_574;
  return (p: Position): [number, number] => [(p[0]! - lon0) * kx, (p[1]! - lat0) * ky];
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Metres from a point to the nearest edge of a polygon (inside or out). */
function distanceToBoundary(pt: Position, g: Polygon | MultiPolygon): number {
  const local = toLocal(pt[0]!, pt[1]!);
  const p: [number, number] = [0, 0];
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let best = Infinity;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        best = Math.min(best, segDist(p, local(ring[i - 1]!), local(ring[i]!)));
      }
    }
  }
  return best;
}

export interface GateInfo {
  gate_id: number;
  name: string;
  /** The two paddocks joined, or fewer if it could not be worked out. */
  paddocks: number[];
  /** True when set by hand rather than worked out from position. */
  manual: boolean;
  state: "open" | "closed";
  since: { date: string; time: string | null } | null;
}

export function detectPaddocks(gate: FeatureRow, paddocks: FeatureRow[]): number[] {
  const g = JSON.parse(gate.geometry) as { type: string; coordinates: Position };
  if (g.type !== "Point") return [];
  return paddocks
    .map((p) => ({ id: p.id, d: distanceToBoundary(g.coordinates, JSON.parse(p.geometry)) }))
    .filter((x) => x.d <= MAX_METRES)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((x) => x.id);
}

export function isGate(f: FeatureRow): boolean {
  return f.kind === "infrastructure" && (f.subtype ?? "").toLowerCase() === "gate";
}

interface GateEventRow {
  id: number;
  gate_id: number;
  paddock_a: number;
  paddock_b: number;
  state: "open" | "closed";
  date: string;
  time: string | null;
  note: string | null;
  batch: string;
  username: string | null;
  created_at: number;
}

const GATE_ORDER = "date, IFNULL(time, ''), id";

/** The latest open/close at or before a moment; closed if never recorded. */
export function gateStateAt(gateId: number, date: string, time: string | null): GateEventRow | null {
  const rows = db.prepare(`SELECT * FROM gate_events WHERE gate_id = ? AND date <= ? ORDER BY ${GATE_ORDER}`)
    .all(gateId, date) as GateEventRow[];
  const upTo = rows.filter((r) => r.date < date || time === null || r.time === null || r.time <= time);
  return upTo[upTo.length - 1] ?? null;
}

export function gateHistory(gateId: number): GateEventRow[] {
  return (db.prepare(`SELECT * FROM gate_events WHERE gate_id = ? ORDER BY ${GATE_ORDER}`).all(gateId) as GateEventRow[]).reverse();
}

export function listGates(): GateInfo[] {
  const features = listFeatures();
  const paddocks = features.filter((f) => f.kind === "paddock");
  const latest = new Map<number, GateEventRow>();
  for (const e of db.prepare(`SELECT * FROM gate_events ORDER BY ${GATE_ORDER}`).all() as GateEventRow[]) {
    latest.set(e.gate_id, e);
  }
  return features.filter(isGate).map((g) => gateInfo(g, paddocks, latest.get(g.id) ?? null));
}

export function gateInfo(g: FeatureRow, paddocks: FeatureRow[], last: GateEventRow | null): GateInfo {
  const props = JSON.parse(g.props) as Record<string, unknown>;
  const set = Array.isArray(props["connects"]) ? (props["connects"] as unknown[]).map(Number) : null;
  const valid = set && set.length === 2 && set.every((id) => paddocks.some((p) => p.id === id));
  return {
    gate_id: g.id,
    name: g.name,
    paddocks: valid ? set! : detectPaddocks(g, paddocks),
    manual: !!valid,
    state: last?.state ?? "closed",
    since: last ? { date: last.date, time: last.time } : null,
  };
}

export type { GateEventRow };
