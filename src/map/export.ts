/**
 * The whole map out again, in formats anything can open.
 *
 * This matters more than it looks. The reason this app exists is that the
 * farm's records were held somewhere that could change the terms at will, so
 * getting everything back out in a standard format is a feature, not an
 * afterthought. GeoJSON keeps every field; KML opens in Google Earth.
 */
import type { Position } from "geojson";
import { KIND_BY_ID, KINDS } from "./kinds.js";
import type { MapGeometry } from "./geometry.js";
import { listFeatures, toFeature, type MapFeature } from "./store.js";

export function exportGeoJson(): { type: "FeatureCollection"; features: MapFeature[] } {
  return { type: "FeatureCollection", features: listFeatures().map(toFeature) };
}

/** Signed area of a ring in plain lon/lat: positive when anticlockwise. */
const ringSign = (r: Position[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j]![0]! * r[i]![1]! - r[i]![0]! * r[j]![1]!;
  return a;
};

/** RFC 7946 winding (outer rings anticlockwise, holes clockwise), 2-D, 7 decimals (~1 cm). */
function tidyPolygon(rings: Position[][]): number[][][] {
  return rings.map((ring, i) => {
    const pts = ring.map((p) => [Math.round(p[0]! * 1e7) / 1e7, Math.round(p[1]! * 1e7) / 1e7]);
    const ccw = ringSign(pts) > 0;
    return (i === 0) === ccw ? pts : pts.reverse();
  });
}

/**
 * Paddock boundaries only, with plain flat properties: what a mapping service
 * such as Cibo Labs wants when it's given the property's paddocks. Points,
 * fences and the app's own bookkeeping are left out.
 */
export function exportPaddocksGeoJson() {
  const features = listFeatures()
    .filter((r) => r.kind === "paddock")
    .map(toFeature)
    .filter((f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name, undefined, { numeric: true }))
    .map((f) => ({
      type: "Feature" as const,
      properties: {
        name: f.properties.name,
        area_ha: f.properties.area_ha === null ? null : Math.round(f.properties.area_ha * 100) / 100,
        land_use: f.properties.subtype,
        paddock_id: f.id,
      },
      geometry: f.geometry.type === "Polygon"
        ? { type: "Polygon" as const, coordinates: tidyPolygon(f.geometry.coordinates) }
        : { type: "MultiPolygon" as const, coordinates: (f.geometry.coordinates as Position[][][]).map(tidyPolygon) },
    }));
  return { type: "FeatureCollection" as const, features };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const coords = (ps: Position[]) => ps.map((p) => `${p[0]},${p[1]}`).join(" ");

function polygonKml(rings: Position[][]): string {
  const [outer, ...holes] = rings;
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(outer ?? [])}</coordinates></LinearRing></outerBoundaryIs>${
    holes.map((h) => `<innerBoundaryIs><LinearRing><coordinates>${coords(h)}</coordinates></LinearRing></innerBoundaryIs>`).join("")
  }</Polygon>`;
}

function geometryKml(g: MapGeometry): string {
  switch (g.type) {
    case "Point":
      return `<Point><coordinates>${g.coordinates[0]},${g.coordinates[1]}</coordinates></Point>`;
    case "LineString":
      return `<LineString><coordinates>${coords(g.coordinates)}</coordinates></LineString>`;
    case "MultiLineString":
      return `<MultiGeometry>${g.coordinates.map((l) => `<LineString><coordinates>${coords(l)}</coordinates></LineString>`).join("")}</MultiGeometry>`;
    case "Polygon":
      return polygonKml(g.coordinates);
    case "MultiPolygon":
      return `<MultiGeometry>${g.coordinates.map(polygonKml).join("")}</MultiGeometry>`;
  }
}

export function exportKml(propertyName: string): string {
  const features = listFeatures().map(toFeature);
  const folders = KINDS.map((k) => {
    const items = features.filter((f) => f.properties.kind === k.id);
    if (items.length === 0) return "";
    const placemarks = items.map((f) => {
      const p = f.properties;
      const data: Array<[string, unknown]> = [
        ["id", f.id],
        ["kind", KIND_BY_ID.get(p.kind)?.label ?? p.kind],
        ["subtype", p.subtype],
        ["area_ha", p.area_ha],
        ["length_m", p.length_m],
        ...Object.entries(p.props).filter(([, v]) => v === null || typeof v !== "object"),
      ];
      const ext = data
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(String(v))}</value></Data>`)
        .join("");
      return `<Placemark><name>${esc(p.name)}</name><ExtendedData>${ext}</ExtendedData>${geometryKml(f.geometry)}</Placemark>`;
    }).join("\n");
    return `<Folder><name>${esc(k.label)}</name>\n${placemarks}\n</Folder>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>${esc(propertyName)}</name>
${folders}
</Document>
</kml>
`;
}
