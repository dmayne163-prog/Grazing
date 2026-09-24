import type { MultiPolygon, Polygon } from "geojson";
import { db } from "../db/database.js";
import { allowsGeom, KIND_BY_ID } from "./kinds.js";
import {
  GeometryError, geomClass, measure, normaliseGeometry, splitPolygon, type MapGeometry,
} from "./geometry.js";

export interface FeatureRow {
  id: number;
  kind: string;
  name: string;
  subtype: string | null;
  props: string;
  geometry: string;
  area_ha: number | null;
  length_m: number | null;
  rev: number;
  source: string;
  parent_id: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** A feature as the API hands it out: a GeoJSON Feature with our fields in properties. */
export interface MapFeature {
  type: "Feature";
  id: number;
  geometry: MapGeometry;
  properties: {
    kind: string;
    name: string;
    subtype: string | null;
    props: Record<string, unknown>;
    area_ha: number | null;
    length_m: number | null;
    rev: number;
    source: string;
    parent_id: number | null;
    updated_at: number;
  };
}

export function toFeature(r: FeatureRow): MapFeature {
  return {
    type: "Feature",
    id: r.id,
    geometry: JSON.parse(r.geometry) as MapGeometry,
    properties: {
      kind: r.kind,
      name: r.name,
      subtype: r.subtype,
      props: JSON.parse(r.props) as Record<string, unknown>,
      area_ha: r.area_ha,
      length_m: r.length_m,
      rev: r.rev,
      source: r.source,
      parent_id: r.parent_id,
      updated_at: r.updated_at,
    },
  };
}

export function listFeatures(): FeatureRow[] {
  return db.prepare(
    "SELECT * FROM features WHERE deleted_at IS NULL ORDER BY kind, name COLLATE NOCASE, id"
  ).all() as FeatureRow[];
}

export function getFeature(id: number): FeatureRow | null {
  return (db.prepare("SELECT * FROM features WHERE id = ?").get(id) as FeatureRow | undefined) ?? null;
}

/* ------------------------------- validation ------------------------------ */

export interface FeatureInput {
  kind: string;
  name?: string;
  subtype?: string | null;
  props?: Record<string, unknown>;
  geometry: unknown;
}

interface Clean {
  kind: string;
  name: string;
  subtype: string | null;
  props: string;
  geometry: MapGeometry;
  area_ha: number | null;
  length_m: number | null;
}

function clean(input: FeatureInput): Clean {
  const def = KIND_BY_ID.get(input.kind);
  if (!def) throw new GeometryError(`Unknown feature type "${String(input.kind)}"`);

  const geometry = normaliseGeometry(input.geometry);
  if (!allowsGeom(def, geomClass(geometry))) {
    const want = def.geoms
      .map((g) => (g === "polygon" ? "an area" : g === "line" ? "a line" : "a point"))
      .join(" or ");
    throw new GeometryError(`A ${def.label.toLowerCase()} must be drawn as ${want}`);
  }

  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  const subtype = typeof input.subtype === "string" && input.subtype.trim() !== ""
    ? input.subtype.trim().slice(0, 60)
    : null;

  const props = input.props && typeof input.props === "object" && !Array.isArray(input.props)
    ? input.props
    : {};
  const propsJson = JSON.stringify(props);
  if (propsJson.length > 20_000) throw new GeometryError("Too much attribute data on one feature");

  return { kind: def.id, name, subtype, props: propsJson, geometry, ...measure(geometry) };
}

/* -------------------------------- writing -------------------------------- */

/**
 * The area AgriWebb reported is kept on imported paddocks for comparison, but
 * only while the boundary is still AgriWebb's. Once the shape changes here the
 * figure describes a paddock that no longer exists, so it goes.
 */
function withoutStaleArea(props: string): string {
  const p = JSON.parse(props) as Record<string, unknown>;
  if (!("agriwebb_area_ha" in p)) return props;
  delete p["agriwebb_area_ha"];
  return JSON.stringify(p);
}

function writeRevision(id: number, action: string, username: string | null) {
  const r = getFeature(id)!;
  db.prepare(`
    INSERT INTO feature_revisions
      (feature_id, rev, ts, username, action, kind, name, subtype, props, geometry,
       area_ha, length_m, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.id, r.rev, r.updated_at, username, action, r.kind, r.name, r.subtype, r.props,
    r.geometry, r.area_ha, r.length_m, r.deleted_at === null ? 0 : 1
  );
}

function insertClean(c: Clean, source: string, parentId: number | null, username: string | null): number {
  const now = Date.now();
  const res = db.prepare(`
    INSERT INTO features
      (kind, name, subtype, props, geometry, area_ha, length_m, rev, source, parent_id,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    c.kind, c.name, c.subtype, c.props, JSON.stringify(c.geometry), c.area_ha, c.length_m,
    source, parentId, now, now
  );
  const id = Number(res.lastInsertRowid);
  writeRevision(id, "create", username);
  return id;
}

export function createFeature(input: FeatureInput, source: string, username: string | null): number {
  const c = clean(input);
  return db.transaction(() => insertClean(c, source, null, username))();
}

/** Many at once, all or nothing — used by the file import. */
export function createFeatures(
  inputs: FeatureInput[], source: string, username: string | null
): number[] {
  const cleaned = inputs.map(clean);
  return db.transaction(() => cleaned.map((c) => insertClean(c, source, null, username)))();
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

/**
 * Updates a feature. `rev` is the revision the editor started from; if the
 * feature has moved on since — somebody else saved it from another phone — the
 * save is refused rather than silently overwriting their change.
 */
export function updateFeature(
  id: number, input: FeatureInput, rev: number, username: string | null
): FeatureRow {
  const c = clean(input);
  return db.transaction(() => {
    const cur = getFeature(id);
    if (!cur || cur.deleted_at !== null) throw new NotFoundError("No such feature");
    if (cur.rev !== rev) {
      throw new ConflictError("This was changed by someone else since you opened it. Reload and try again.");
    }
    const geometryJson = JSON.stringify(c.geometry);
    const props = geometryJson === cur.geometry ? c.props : withoutStaleArea(c.props);
    db.prepare(`
      UPDATE features SET kind = ?, name = ?, subtype = ?, props = ?, geometry = ?,
        area_ha = ?, length_m = ?, rev = rev + 1, updated_at = ?
      WHERE id = ?
    `).run(
      c.kind, c.name, c.subtype, props, geometryJson, c.area_ha, c.length_m, Date.now(), id
    );
    writeRevision(id, "update", username);
    return getFeature(id)!;
  })();
}

export function deleteFeature(id: number, username: string | null) {
  db.transaction(() => {
    const cur = getFeature(id);
    if (!cur || cur.deleted_at !== null) throw new NotFoundError("No such feature");
    const now = Date.now();
    db.prepare("UPDATE features SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    writeRevision(id, "delete", username);
  })();
}

/** Brings back a deleted feature — the undo for a delete. */
export function restoreFeature(id: number, username: string | null) {
  db.transaction(() => {
    const cur = getFeature(id);
    if (!cur || cur.deleted_at === null) throw new NotFoundError("Nothing to restore");
    db.prepare("UPDATE features SET deleted_at = NULL, rev = rev + 1, updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    writeRevision(id, "restore", username);
  })();
}

/**
 * Subdivides a paddock. The original keeps its id and name and shrinks to
 * what is left; the carved-off piece becomes a new paddock that remembers
 * where it came from. Keeping the original id is deliberate: whatever history
 * is attached to "Bottom Flat" stays with the part still called Bottom Flat.
 */
export function splitFeature(
  id: number, cutter: unknown, newName: string, rev: number, username: string | null
): { parent: FeatureRow; child: FeatureRow } {
  const cutGeom = normaliseGeometry(cutter);
  if (geomClass(cutGeom) !== "polygon") throw new GeometryError("Draw the new paddock as an area");

  return db.transaction(() => {
    const cur = getFeature(id);
    if (!cur || cur.deleted_at !== null) throw new NotFoundError("No such paddock");
    if (cur.kind !== "paddock") throw new GeometryError("Only paddocks can be split");
    if (cur.rev !== rev) {
      throw new ConflictError("This paddock was changed since you opened it. Reload and try again.");
    }

    const parentGeom = JSON.parse(cur.geometry) as Polygon | MultiPolygon;
    const { inside, remainder } = splitPolygon(parentGeom, cutGeom as Polygon | MultiPolygon);

    const m = measure(remainder);
    db.prepare(`
      UPDATE features SET geometry = ?, area_ha = ?, props = ?, rev = rev + 1, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(remainder), m.area_ha, withoutStaleArea(cur.props), Date.now(), id);
    writeRevision(id, "split", username);

    const childId = insertClean(
      clean({
        kind: "paddock",
        name: newName.trim() || `${cur.name} (split)`,
        subtype: cur.subtype,
        props: {},
        geometry: inside,
      }),
      `split:${id}`,
      id,
      username
    );

    return { parent: getFeature(id)!, child: getFeature(childId)! };
  })();
}

export interface RevisionRow {
  feature_id: number;
  rev: number;
  ts: number;
  username: string | null;
  action: string;
  name: string;
  area_ha: number | null;
  length_m: number | null;
  deleted: number;
}

export function listRevisions(id: number): RevisionRow[] {
  return db.prepare(`
    SELECT feature_id, rev, ts, username, action, name, area_ha, length_m, deleted
    FROM feature_revisions WHERE feature_id = ? ORDER BY rev DESC
  `).all(id) as RevisionRow[];
}

/** Recently deleted features, so a mistaken delete can be found and undone. */
export function listDeleted(limit = 50): FeatureRow[] {
  return db.prepare(
    "SELECT * FROM features WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?"
  ).all(limit) as FeatureRow[];
}
