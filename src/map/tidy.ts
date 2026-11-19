/**
 * Paddock boundary checks and the overlap tidy-up.
 *
 * Paddocks drawn at different times along the same fence never quite agree,
 * so neighbours overlap in thin slivers. Each sliver is counted twice in the
 * property's area, and services that want clean paddocks (FORAGE, for one)
 * refuse the file. The tidy-up gives each sliver to one paddock only: the
 * larger paddock gives way to the smaller, because the smaller one is
 * usually the one drawn carefully along that fence, and a few square metres
 * matter less to a big paddock.
 *
 * Only slivers are tidied. An overlap that is a real share of the smaller
 * paddock (a yard drawn inside a paddock, two paddocks drawn over each other)
 * is listed for checking by hand and left alone.
 */
import turfDifference from "@turf/difference";
import turfIntersect from "@turf/intersect";
import { feature, featureCollection } from "@turf/helpers";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { db, getSetting, setSetting } from "../db/database.js";
import { areaM2, measure, normaliseGeometry } from "./geometry.js";
import { ConflictError, getFeature, listFeatures, NotFoundError, type FeatureRow } from "./store.js";

type Area = Polygon | MultiPolygon;

/** Overlaps smaller than this (10 m²) are rounding, not a problem. */
const MIN_OVERLAP_HA = 0.001;
/** Tidied only when the overlap is at most this much of the smaller paddock... */
const MAX_SHARE = 0.1;
/** ...and no more than this in hectares. */
const MAX_TIDY_HA = 2;
/** Bits left over after trimming smaller than this are dropped. */
const MIN_PART_HA = 0.05;

const ha = (g: Area) => areaM2(g) / 10_000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

const polysOf = (g: Area): Position[][][] => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
const ringsOf = (g: Area): Position[][] => polysOf(g).flat();

/* ------------------------------ self-crossing ----------------------------- */

const orient = (p: Position, q: Position, r: Position) =>
  Math.sign((q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!));

/** Where two edges of one ring cross: the boundary goes over itself like a figure 8. */
function ringCrossings(ring: Position[]): Position[] {
  const n = ring.length - 1;
  const out: Position[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the edges either side of the start point
      const c = ring[j]!, d = ring[j + 1]!;
      const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
      if (o1 && o2 && o3 && o4 && o1 !== o2 && o3 !== o4) {
        // Where they cross, for showing on the map.
        const t = ((c[0]! - a[0]!) * (d[1]! - c[1]!) - (c[1]! - a[1]!) * (d[0]! - c[0]!)) /
          ((b[0]! - a[0]!) * (d[1]! - c[1]!) - (b[1]! - a[1]!) * (d[0]! - c[0]!));
        out.push([a[0]! + t * (b[0]! - a[0]!), a[1]! + t * (b[1]! - a[1]!)]);
      }
    }
  }
  return out;
}

/** Corners where the boundary doubles straight back on itself: a zero-width spike. */
function ringSpikes(ring: Position[]): Position[] {
  const n = ring.length - 1;
  const out: Position[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n]!, b = ring[i]!, c = ring[(i + 1) % n]!;
    const v1 = [a[0]! - b[0]!, a[1]! - b[1]!], v2 = [c[0]! - b[0]!, c[1]! - b[1]!];
    const len = Math.hypot(v1[0]!, v1[1]!) * Math.hypot(v2[0]!, v2[1]!);
    if (len > 0 && (v1[0]! * v2[0]! + v1[1]! * v2[1]!) / len > 0.9995) out.push(b);
  }
  return out;
}

export interface ShapeProblems {
  crossings: Position[];
  spikes: Position[];
}

export function shapeProblems(g: Area): ShapeProblems {
  const rings = ringsOf(g);
  return { crossings: rings.flatMap(ringCrossings), spikes: rings.flatMap(ringSpikes) };
}

/** Removes spike corners, repeating until none are left (removing one can expose another). */
function withoutSpikes(g: Area): Area {
  const fixRing = (ring: Position[]): Position[] => {
    let pts = ring.slice(0, -1);
    for (let guard = 0; guard < 50 && pts.length > 3; guard++) {
      const closed = [...pts, pts[0]!];
      const spikes = new Set(ringSpikes(closed));
      if (!spikes.size) break;
      pts = pts.filter((p) => !spikes.has(p));
    }
    return [...pts, pts[0]!];
  };
  const polys = polysOf(g).map((rings) => rings.map(fixRing));
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0]! } : { type: "MultiPolygon", coordinates: polys };
}

/** Plain words for a save's warnings, or none. */
export function describeShapeProblems(p: ShapeProblems): string[] {
  const out: string[] = [];
  if (p.crossings.length) {
    out.push(`The boundary crosses itself ${p.crossings.length === 1 ? "in one place" : `in ${p.crossings.length} places`}, like a figure 8. Reshape it so the line doesn't cross over; FORAGE and Cibo Labs can't read a boundary like this.`);
  }
  if (p.spikes.length) {
    out.push(`The boundary doubles back on itself at ${p.spikes.length === 1 ? "one corner" : `${p.spikes.length} corners`} (a thin spike). Remove the spike's corner with a right-click or long-press.`);
  }
  return out;
}

/* -------------------------------- overlaps -------------------------------- */

interface Paddock { row: FeatureRow; geom: Area; ha: number; bbox: [number, number, number, number] }

function paddocks(): Paddock[] {
  return listFeatures()
    .filter((r) => r.kind === "paddock")
    .map((row) => ({ row, geom: JSON.parse(row.geometry) as Area }))
    .filter((p) => p.geom.type === "Polygon" || p.geom.type === "MultiPolygon")
    .map((p) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const ring of ringsOf(p.geom)) for (const [x, y] of ring) {
        x0 = Math.min(x0, x!); y0 = Math.min(y0, y!); x1 = Math.max(x1, x!); y1 = Math.max(y1, y!);
      }
      return { ...p, ha: ha(p.geom), bbox: [x0, y0, x1, y1] as [number, number, number, number] };
    });
}

const boxesMeet = (a: Paddock, b: Paddock) =>
  a.bbox[0] <= b.bbox[2] && b.bbox[0] <= a.bbox[2] && a.bbox[1] <= b.bbox[3] && b.bbox[1] <= a.bbox[3];

export interface Overlap {
  /** The paddock that gives the sliver up (the larger one). */
  gives: { id: number; name: string; area_ha: number };
  /** The paddock that keeps it (the smaller one). */
  keeps: { id: number; name: string; area_ha: number };
  overlap_ha: number;
  /** "tidy" when it's a sliver the tidy-up will fix; "check" when it's too big to fix blind. */
  action: "tidy" | "check";
  geometry: Area;
}

function findOverlaps(list: Paddock[], only?: Paddock): Overlap[] {
  const out: Overlap[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!, b = list[j]!;
      if (only && a !== only && b !== only) continue;
      if (!boxesMeet(a, b)) continue;
      let x;
      try { x = turfIntersect(featureCollection([feature(a.geom), feature(b.geom)])); } catch { continue; }
      if (!x) continue;
      const g = x.geometry as Area;
      const o = ha(g);
      if (o < MIN_OVERLAP_HA) continue;
      const [big, small] = a.ha >= b.ha ? [a, b] : [b, a];
      out.push({
        gives: { id: big.row.id, name: big.row.name, area_ha: big.row.area_ha ?? r3(big.ha) },
        keeps: { id: small.row.id, name: small.row.name, area_ha: small.row.area_ha ?? r3(small.ha) },
        overlap_ha: r3(o),
        action: o <= MAX_TIDY_HA && o <= MAX_SHARE * small.ha ? "tidy" : "check",
        geometry: g,
      });
    }
  }
  return out.sort((p, q) => q.overlap_ha - p.overlap_ha);
}

/** Overlaps between one paddock (as it's about to be saved) and the others. */
export function overlapsWith(id: number | null, geometry: Area): Array<{ name: string; overlap_ha: number }> {
  const list = paddocks().filter((p) => p.row.id !== id);
  const me: Paddock = {
    row: { id: id ?? 0, name: "" } as FeatureRow, geom: geometry, ha: ha(geometry),
    bbox: [Infinity, Infinity, -Infinity, -Infinity],
  };
  for (const ring of ringsOf(geometry)) for (const [x, y] of ring) {
    me.bbox = [Math.min(me.bbox[0], x!), Math.min(me.bbox[1], y!), Math.max(me.bbox[2], x!), Math.max(me.bbox[3], y!)];
  }
  return findOverlaps([me, ...list], me)
    .filter((o) => o.overlap_ha >= 0.01)
    .map((o) => ({ name: o.gives.id === me.row.id ? o.keeps.name : o.gives.name, overlap_ha: o.overlap_ha }));
}

/* ---------------------------------- plan ---------------------------------- */

export interface TidyChange {
  id: number;
  name: string;
  rev: number;
  before_ha: number;
  after_ha: number;
  /** Who it gives ground to. */
  gives_to: string[];
  geometry: Area;
}

export interface TidyPlan {
  paddocks: number;
  overlaps: Overlap[];
  changes: TidyChange[];
  /** Paddocks the tidy-up would have changed but couldn't do cleanly; left as they are. */
  skipped: Array<{ name: string; reason: string }>;
  shapes: Array<{ id: number; name: string; crossings: Position[]; spikes: Position[] }>;
  total_overlap_ha: number;
  last_tidy: { at: number; username: string | null; count: number } | null;
}

/** Drops the specks a trim leaves behind: parts and holes under MIN_PART_HA. */
function withoutSpecks(g: Area, original: Area): Area | null {
  // A part the paddock already had is kept whatever its size: that's how it was drawn.
  const had = new Set(polysOf(original).map((p) => Math.round(areaM2({ type: "Polygon", coordinates: [p[0]!] }))));
  const polys = polysOf(g)
    .filter((p) => had.has(Math.round(areaM2({ type: "Polygon", coordinates: [p[0]!] }))) ||
      areaM2({ type: "Polygon", coordinates: [p[0]!] }) / 10_000 >= MIN_PART_HA)
    .map(([outer, ...holes]) => [outer!, ...holes.filter((h) => areaM2({ type: "Polygon", coordinates: [h] }) / 10_000 >= MIN_PART_HA)]);
  if (!polys.length) return null;
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0]! } : { type: "MultiPolygon", coordinates: polys };
}

export function planTidy(): TidyPlan {
  const list = paddocks();
  const overlaps = findOverlaps(list);
  const byId = new Map(list.map((p) => [p.row.id, p]));

  // Each paddock that gives way loses every smaller neighbour's ground at once.
  const cutters = new Map<number, Paddock[]>();
  for (const o of overlaps) {
    if (o.action !== "tidy") continue;
    const arr = cutters.get(o.gives.id) ?? [];
    arr.push(byId.get(o.keeps.id)!);
    cutters.set(o.gives.id, arr);
  }

  const changes: TidyChange[] = [];
  const skipped: TidyPlan["skipped"] = [];
  for (const [id, cuts] of cutters) {
    const p = byId.get(id)!;
    try {
      const diff = turfDifference(featureCollection([feature(p.geom), ...cuts.map((c) => feature(c.geom))]));
      if (!diff) throw new Error("nothing would be left");
      const specks = withoutSpecks(diff.geometry as Area, p.geom);
      if (!specks) throw new Error("nothing would be left");
      const g = normaliseGeometry(withoutSpikes(normaliseGeometry(specks) as Area)) as Area;
      const probs = shapeProblems(g);
      if (probs.crossings.length) throw new Error("the trimmed boundary would cross itself");
      const after = measure(g).area_ha!;
      changes.push({
        id, name: p.row.name, rev: p.row.rev,
        before_ha: p.row.area_ha ?? r3(p.ha), after_ha: after,
        gives_to: cuts.map((c) => c.row.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        geometry: g,
      });
    } catch (e) {
      skipped.push({ name: p.row.name, reason: (e as Error).message });
    }
  }
  changes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const shapes = list
    .map((p) => ({ id: p.row.id, name: p.row.name, ...shapeProblems(p.geom) }))
    .filter((s) => s.crossings.length || s.spikes.length);

  const last = getSetting("boundary_tidy_last");
  const lt = last ? JSON.parse(last) as { at: number; username: string | null; items: unknown[] } : null;

  return {
    paddocks: list.length,
    overlaps,
    changes,
    skipped,
    shapes,
    total_overlap_ha: r3(overlaps.reduce((s, o) => s + o.overlap_ha, 0)),
    last_tidy: lt ? { at: lt.at, username: lt.username, count: lt.items.length } : null,
  };
}

/* ------------------------------ apply and undo ---------------------------- */

function writeRevision(id: number, action: string, username: string | null) {
  const r = getFeature(id)!;
  db.prepare(`
    INSERT INTO feature_revisions
      (feature_id, rev, ts, username, action, kind, name, subtype, props, geometry,
       area_ha, length_m, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, r.rev, r.updated_at, username, action, r.kind, r.name, r.subtype, r.props,
    r.geometry, r.area_ha, r.length_m, r.deleted_at === null ? 0 : 1);
}

/**
 * Applies the plan. `revs` is what the person saw — each paddock's revision
 * when the plan was shown. If any has changed since, nothing is applied.
 */
export function applyTidy(revs: Record<string, number>, username: string | null): { changed: number; plan: TidyPlan } {
  const plan = planTidy();
  if (!plan.changes.length) throw new ConflictError("There's nothing to tidy.");
  const seen = new Set(Object.keys(revs).map(Number));
  for (const c of plan.changes) {
    if (!seen.has(c.id) || revs[String(c.id)] !== c.rev) {
      throw new ConflictError("A paddock boundary changed since this was shown. Close and open the tidy-up again.");
    }
  }
  if (seen.size !== plan.changes.length) {
    throw new ConflictError("The paddocks to change are not the ones shown. Close and open the tidy-up again.");
  }

  const items: Array<{ id: number; rev: number }> = [];
  db.transaction(() => {
    const now = Date.now();
    for (const c of plan.changes) {
      const cur = getFeature(c.id)!;
      const props = JSON.parse(cur.props) as Record<string, unknown>;
      delete props["agriwebb_area_ha"]; // the shape is no longer AgriWebb's
      db.prepare(`UPDATE features SET geometry = ?, area_ha = ?, props = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(c.geometry), c.after_ha, JSON.stringify(props), now, c.id);
      writeRevision(c.id, "tidy", username);
      items.push({ id: c.id, rev: cur.rev + 1 });
    }
    setSetting("boundary_tidy_last", JSON.stringify({ at: now, username, items }));
  })();
  return { changed: items.length, plan: planTidy() };
}

/**
 * Puts back the boundaries the last tidy-up changed, from their revision
 * history. A paddock reshaped by hand since is left as it is and named.
 */
export function undoTidy(username: string | null): { restored: number; left: string[] } {
  const last = getSetting("boundary_tidy_last");
  if (!last) throw new NotFoundError("There's no tidy-up to undo.");
  const { items } = JSON.parse(last) as { items: Array<{ id: number; rev: number }> };
  let restored = 0;
  const left: string[] = [];
  db.transaction(() => {
    const now = Date.now();
    for (const it of items) {
      const cur = getFeature(it.id);
      if (!cur || cur.deleted_at !== null || cur.rev !== it.rev) { left.push(cur?.name ?? `#${it.id}`); continue; }
      const prev = db.prepare("SELECT geometry, area_ha, props FROM feature_revisions WHERE feature_id = ? AND rev = ?")
        .get(it.id, it.rev - 1) as { geometry: string; area_ha: number | null; props: string } | undefined;
      if (!prev) { left.push(cur.name); continue; }
      db.prepare(`UPDATE features SET geometry = ?, area_ha = ?, props = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
        .run(prev.geometry, prev.area_ha, prev.props, now, it.id);
      writeRevision(it.id, "undo tidy", username);
      restored++;
    }
    db.prepare("DELETE FROM settings WHERE key = ?").run("boundary_tidy_last");
  })();
  return { restored, left };
}
