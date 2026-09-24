import geographiclib from "geographiclib-geodesic";
import turfIntersect from "@turf/intersect";
import turfDifference from "@turf/difference";
import { feature, featureCollection } from "@turf/helpers";
import type {
  Geometry, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position,
} from "geojson";
import { geomClassOf, type GeomClass } from "./kinds.js";

// CommonJS, so the named export has to be taken from the default one.
const { Geodesic } = geographiclib;

export type MapGeometry = Point | LineString | MultiLineString | Polygon | MultiPolygon;

export class GeometryError extends Error {}

/** About 1 cm at this latitude — finer than any GPS or imagery we will see. */
const round = (n: number) => Math.round(n * 1e7) / 1e7;

function cleanPosition(p: Position): Position {
  if (!Array.isArray(p) || p.length < 2) throw new GeometryError("A coordinate is missing values");
  const lon = Number(p[0]);
  const lat = Number(p[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new GeometryError("A coordinate is not a number");
  }
  // Projected coordinates (MGA eastings/northings in metres) are the usual way
  // a file ends up here unreadable. Say so plainly instead of drawing a paddock
  // somewhere off the coast of Africa.
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    throw new GeometryError(
      "Coordinates are not latitude/longitude — the file is probably in a projected " +
      "grid such as MGA. Export it as WGS84 / GDA2020 geographic, or as KML."
    );
  }
  // Altitude from KML is dropped: nothing here uses it, and it would make two
  // otherwise identical shapes compare unequal.
  return [round(lon), round(lat)];
}

function cleanLine(line: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of line) {
    const c = cleanPosition(p);
    const prev = out[out.length - 1];
    if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
    out.push(c);
  }
  return out;
}

function cleanRing(ring: Position[]): Position[] | null {
  const out = cleanLine(ring);
  if (out.length === 0) return null;
  const first = out[0]!;
  const last = out[out.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0]!, first[1]!]);
  // A ring needs three distinct corners plus the closing point.
  return out.length >= 4 ? out : null;
}

function cleanPolygon(rings: Position[][]): Position[][] | null {
  const out: Position[][] = [];
  for (let i = 0; i < rings.length; i++) {
    const r = cleanRing(rings[i]!);
    if (!r) {
      if (i === 0) return null; // no outer ring, no polygon
      continue; // a degenerate hole is just dropped
    }
    out.push(r);
  }
  return out;
}

/**
 * Validates and tidies a geometry before it is stored.
 *
 * Multi-part shapes are kept as they are — a paddock split by a creek, or a
 * fence with a gap for a gateway, is legitimately in more than one piece.
 * A Multi-shape with a single part is flattened, so a paddock that arrives
 * wrapped as a one-part MultiPolygon edits like any other.
 */
export function normaliseGeometry(input: unknown): MapGeometry {
  const g = input as Geometry | null;
  if (!g || typeof g !== "object" || typeof (g as { type?: unknown }).type !== "string") {
    throw new GeometryError("Missing geometry");
  }

  switch (g.type) {
    case "Point":
      return { type: "Point", coordinates: cleanPosition(g.coordinates) };

    case "LineString": {
      const c = cleanLine(g.coordinates);
      if (c.length < 2) throw new GeometryError("A line needs at least two points");
      return { type: "LineString", coordinates: c };
    }

    case "MultiLineString": {
      const parts = g.coordinates.map(cleanLine).filter((l) => l.length >= 2);
      if (parts.length === 0) throw new GeometryError("A line needs at least two points");
      if (parts.length === 1) return { type: "LineString", coordinates: parts[0]! };
      return { type: "MultiLineString", coordinates: parts };
    }

    case "Polygon": {
      const c = cleanPolygon(g.coordinates);
      if (!c) throw new GeometryError("An area needs at least three corners");
      return { type: "Polygon", coordinates: c };
    }

    case "MultiPolygon": {
      const parts = g.coordinates.map(cleanPolygon).filter((p): p is Position[][] => p !== null);
      if (parts.length === 0) throw new GeometryError("An area needs at least three corners");
      if (parts.length === 1) return { type: "Polygon", coordinates: parts[0]! };
      return { type: "MultiPolygon", coordinates: parts };
    }

    default:
      throw new GeometryError(`${g.type} shapes are not supported`);
  }
}

export function geomClass(g: MapGeometry): GeomClass {
  return geomClassOf(g.type)!;
}

export interface Measures {
  area_ha: number | null;
  length_m: number | null;
}

/**
 * Area and length on the WGS84 ellipsoid, using GeographicLib.
 *
 * Spherical formulas are off by a consistent fraction at this latitude, and
 * which way depends on the radius chosen. Turf's mean radius reads 0.23% high
 * against the ellipsoid; the equatorial radius Google Maps uses — and, judging
 * by its figures, AgriWebb — reads 0.45% high, about 48 ha across this
 * property. The ellipsoid is the real answer, so that is what is stored; the
 * AgriWebb figure is kept on imported paddocks for comparison.
 */
function ringArea(ring: Position[]): number {
  const p = Geodesic.WGS84.Polygon(false);
  // The closing point repeats the first; GeographicLib closes rings itself.
  for (const pos of ring.slice(0, -1)) p.AddPoint(pos[1]!, pos[0]!);
  return Math.abs(p.Compute(false, true).area ?? 0);
}

function polygonArea(rings: Position[][]): number {
  const [outer, ...holes] = rings;
  if (!outer) return 0;
  return Math.max(0, ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0));
}

function lineLength(line: Position[]): number {
  const p = Geodesic.WGS84.Polygon(true);
  for (const pos of line) p.AddPoint(pos[1]!, pos[0]!);
  return p.Compute(false, true).perimeter;
}

/** Square metres, for any polygon or multipolygon. */
export function areaM2(g: Polygon | MultiPolygon): number {
  return g.type === "Polygon"
    ? polygonArea(g.coordinates)
    : g.coordinates.reduce((s, poly) => s + polygonArea(poly), 0);
}

export function measure(g: MapGeometry): Measures {
  switch (g.type) {
    case "Polygon":
    case "MultiPolygon":
      return { area_ha: round2(areaM2(g) / 10_000), length_m: null };
    case "LineString":
      return { area_ha: null, length_m: Math.round(lineLength(g.coordinates)) };
    case "MultiLineString":
      return {
        area_ha: null,
        length_m: Math.round(g.coordinates.reduce((s, l) => s + lineLength(l), 0)),
      };
    default:
      return { area_ha: null, length_m: null };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Anything smaller than this left over from a split is a sliver, not a paddock. */
const MIN_SPLIT_HA = 0.05;

/**
 * Carves a new paddock out of an existing one.
 *
 * The cutter is whatever shape was drawn; only the part of it that overlaps the
 * parent counts, so the new fence line can be drawn roughly outside the
 * existing boundary and snaps to it for free. Returns the carved-off piece and
 * what is left of the parent.
 */
export function splitPolygon(
  parent: Polygon | MultiPolygon,
  cutter: Polygon | MultiPolygon
): { inside: Polygon | MultiPolygon; remainder: Polygon | MultiPolygon } {
  const fc = featureCollection([feature(parent), feature(cutter)]);
  const inside = turfIntersect(fc);
  const remainder = turfDifference(fc);

  if (!inside || areaM2(inside.geometry) / 10_000 < MIN_SPLIT_HA) {
    throw new GeometryError("The new shape does not overlap this paddock");
  }
  if (!remainder || areaM2(remainder.geometry) / 10_000 < MIN_SPLIT_HA) {
    throw new GeometryError(
      "The new shape covers the whole paddock — edit its boundary instead of splitting it"
    );
  }

  return {
    inside: normaliseGeometry(inside.geometry) as Polygon | MultiPolygon,
    remainder: normaliseGeometry(remainder.geometry) as Polygon | MultiPolygon,
  };
}

