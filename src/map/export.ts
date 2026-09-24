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
