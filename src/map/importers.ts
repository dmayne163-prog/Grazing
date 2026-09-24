/**
 * Reads farm map files into a list of shapes for review.
 *
 * Nothing here writes to the map. A file is parsed into candidates, each with
 * a suggested kind and name, and shown to a person who confirms or corrects
 * them — because no export format says reliably which lines are fences and
 * which points are troughs, and a wrong guess committed silently is much worse
 * than one question asked up front.
 *
 * Formats: KML, KMZ (zipped KML), a zipped shapefile (with its .prj, which is
 * used to reproject from MGA or any other grid), and GeoJSON — including
 * AgriWebb's map export, which is recognised and mapped field by field.
 */
import { DOMParser } from "@xmldom/xmldom";
import { kmlWithFolders } from "@tmcw/togeojson";
import { unzipSync, strFromU8 } from "fflate";
import { parseZip } from "shpjs";
import type { Feature, FeatureCollection, Geometry, GeoJsonProperties } from "geojson";
import { allowsGeom, defaultKindFor, geomClassOf, KINDS, type GeomClass } from "./kinds.js";
import { GeometryError, measure, normaliseGeometry, type MapGeometry } from "./geometry.js";

export interface Candidate {
  /** Position in the file, used as the key when the reviewed list comes back. */
  i: number;
  name: string;
  kind: string;
  subtype: string | null;
  geometry: MapGeometry;
  area_ha: number | null;
  length_m: number | null;
  /** Folder or layer it came from, which is often the best clue to what it is. */
  group: string | null;
  /** What gets stored on the feature: mapped fields, plus the file's own attributes. */
  props: Record<string, unknown>;
}

export interface Rejected {
  name: string;
  group: string | null;
  reason: string;
}

export interface ParsedImport {
  format: string;
  candidates: Candidate[];
  rejected: Rejected[];
}

export class ImportError extends Error {}

const MAX_FEATURES = 5000;

interface Raw {
  feature: Feature;
  group: string | null;
}

/* --------------------------------- entry --------------------------------- */

export async function parseMapFile(filename: string, data: Buffer): Promise<ParsedImport> {
  const lower = filename.toLowerCase();
  let format: string;
  let raws: Raw[];

  if (lower.endsWith(".kml")) {
    format = "kml";
    raws = fromKml(data.toString("utf8"));
  } else if (lower.endsWith(".kmz")) {
    format = "kmz";
    raws = fromKml(kmlFromKmz(data));
  } else if (lower.endsWith(".geojson") || lower.endsWith(".json")) {
    const fc = readGeoJson(data.toString("utf8"));
    if (isAgriWebbExport(fc)) {
      if (fc.features.length > MAX_FEATURES) throw tooMany(fc.features.length);
      return { format: "agriwebb", ...reviewAgriWebb(fc) };
    }
    format = "geojson";
    raws = fc.features.map((f) => ({ feature: f, group: null }));
  } else if (lower.endsWith(".zip")) {
    // A zip is either a shapefile bundle or a KMZ that was renamed.
    const entries = safeUnzip(data);
    const names = Object.keys(entries).map((n) => n.toLowerCase());
    if (names.some((n) => n.endsWith(".shp"))) {
      format = "shapefile";
      raws = await fromShapefileZip(data);
    } else if (names.some((n) => n.endsWith(".kml"))) {
      format = "kmz";
      raws = fromKml(kmlFromKmz(data));
    } else {
      throw new ImportError("That zip holds neither a shapefile (.shp) nor a KML file");
    }
  } else if (lower.endsWith(".shp")) {
    throw new ImportError(
      "A shapefile is several files (.shp, .dbf, .prj and more). Zip them together and import the zip."
    );
  } else {
    throw new ImportError("Unsupported file. Use KML, KMZ, a zipped shapefile or GeoJSON.");
  }

  if (raws.length > MAX_FEATURES) throw tooMany(raws.length);

  return { format, ...review(raws) };
}

const tooMany = (n: number) =>
  new ImportError(`That file has ${n} shapes; the limit is ${MAX_FEATURES}`);

/* --------------------------------- formats ------------------------------- */

function safeUnzip(data: Buffer): Record<string, Uint8Array> {
  try {
    return unzipSync(new Uint8Array(data));
  } catch {
    throw new ImportError("The file could not be unzipped — it may be damaged");
  }
}

function kmlFromKmz(data: Buffer): string {
  const entries = safeUnzip(data);
  // doc.kml by convention, but any .kml at the top level will do.
  const names = Object.keys(entries).filter((n) => n.toLowerCase().endsWith(".kml"));
  const pick = names.find((n) => n.toLowerCase() === "doc.kml") ?? names[0];
  if (!pick) throw new ImportError("The KMZ has no KML inside it");
  return strFromU8(entries[pick]!);
}

interface KmlNode {
  type: string;
  meta?: { name?: unknown };
  children?: KmlNode[];
}

function fromKml(text: string): Raw[] {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, "text/xml");
  } catch (e) {
    throw new ImportError(`The KML could not be read: ${String((e as Error).message ?? e)}`);
  }

  // Folders are kept, because an export's folder names ("Paddocks", "Water
  // Points", "Fences") are the most reliable hint to what each shape is.
  // xmldom's Document is close enough to the DOM one for togeojson, but not typed as it.
  const root = kmlWithFolders(doc as unknown as Parameters<typeof kmlWithFolders>[0]) as unknown as KmlNode;
  const out: Raw[] = [];

  const walk = (node: KmlNode, path: string[]) => {
    if (node.type === "Feature") {
      out.push({ feature: node as unknown as Feature, group: path.length ? path.join(" / ") : null });
      return;
    }
    const name = node.type === "folder" && typeof node.meta?.name === "string" ? node.meta.name : null;
    const next = name ? [...path, name] : path;
    for (const c of node.children ?? []) walk(c, next);
  };
  walk(root, []);

  if (out.length === 0) throw new ImportError("No shapes were found in that KML");
  return out;
}

function readGeoJson(text: string): FeatureCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError("That file is not valid JSON");
  }
  const p = parsed as { type?: string; features?: unknown };
  if (p.type === "FeatureCollection" && Array.isArray(p.features)) return parsed as FeatureCollection;
  if (p.type === "Feature") return { type: "FeatureCollection", features: [parsed as Feature] };
  throw new ImportError("Expected a GeoJSON FeatureCollection");
}

async function fromShapefileZip(data: Buffer): Promise<Raw[]> {
  let result: unknown;
  try {
    result = await parseZip(data);
  } catch (e) {
    throw new ImportError(`The shapefile could not be read: ${String((e as Error).message ?? e)}`);
  }
  // One collection per layer when the zip holds several shapefiles.
  const layers = (Array.isArray(result) ? result : [result]) as Array<
    FeatureCollection & { fileName?: string }
  >;
  const out: Raw[] = [];
  for (const layer of layers) {
    const group = layer.fileName ? layer.fileName.replace(/^.*[\\/]/, "") : null;
    for (const f of layer.features) out.push({ feature: f, group });
  }
  return out;
}

/* -------------------------------- reviewing ------------------------------ */

/**
 * GeometryCollections (KML MultiGeometry) are split by shape class, so a
 * placemark holding a paddock outline and a pin becomes two candidates rather
 * than being rejected.
 */
function explode(g: Geometry): Geometry[] {
  if (g.type !== "GeometryCollection") return [g];
  const polys: number[][][][] = [];
  const lines: number[][][] = [];
  const points: Geometry[] = [];
  for (const part of g.geometries.flatMap(explode)) {
    if (part.type === "Polygon") polys.push(part.coordinates);
    else if (part.type === "MultiPolygon") polys.push(...part.coordinates);
    else if (part.type === "LineString") lines.push(part.coordinates);
    else if (part.type === "MultiLineString") lines.push(...part.coordinates);
    else if (part.type === "Point") points.push(part);
    else if (part.type === "MultiPoint") {
      for (const c of part.coordinates) points.push({ type: "Point", coordinates: c });
    }
  }
  const out: Geometry[] = [];
  if (polys.length) out.push({ type: "MultiPolygon", coordinates: polys });
  if (lines.length) out.push({ type: "MultiLineString", coordinates: lines });
  out.push(...points);
  return out;
}

const NAME_KEYS = ["name", "paddock", "paddock_name", "paddockname", "title", "label", "description"];

function nameOf(props: GeoJsonProperties): string {
  if (!props) return "";
  const lowerMap = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const want of NAME_KEYS) {
    const key = lowerMap.get(want);
    const v = key ? props[key] : undefined;
    if (typeof v === "string" && v.trim() !== "" && v.length <= 120) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** Styling from KML and simplestyle — worth nothing once it is on our map. */
const STYLE_KEYS = new Set([
  "stroke", "stroke-width", "stroke-opacity", "fill", "fill-opacity", "styleUrl",
  "styleHash", "styleMapHash", "icon", "icon-scale", "icon-offset", "icon-offset-units",
  "label-scale", "marker-color", "marker-size", "marker-symbol",
]);

function attrsOf(props: GeoJsonProperties): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (STYLE_KEYS.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") continue;
    out[k] = v;
  }
  return out;
}

interface Guess { kind: string; subtype: string | null }

const POINT_RULES: Array<[RegExp, string, string]> = [
  [/\btrough/i, "water", "trough"],
  [/\bbore\b/i, "water", "bore"],
  [/\btank\b/i, "water", "tank"],
  [/turkey ?nest/i, "water", "turkey nest"],
  [/\bdam\b/i, "water", "dam"],
  [/\bcreek|river|waterhole/i, "water", "creek"],
  [/\bwater/i, "water", ""],
  [/\bgate/i, "infrastructure", "gate"],
  [/\byards?\b/i, "infrastructure", "yards"],
  [/\bgrid\b/i, "infrastructure", "grid"],
  [/\bshed|\bhouse|\bhomestead/i, "infrastructure", "shed"],
  [/\bsilo/i, "infrastructure", "silo"],
  [/\blick|supplement|feeder/i, "infrastructure", "lick station"],
  [/\bgauge|rain/i, "infrastructure", "rain gauge"],
];

const LINE_RULES: Array<[RegExp, string, string]> = [
  [/\bpipe/i, "pipeline", ""],
  [/\broad\b/i, "track", "road"],
  [/\btrack|firebreak/i, "track", ""],
  [/\belectric|hot ?wire/i, "fence", "electric"],
  [/\bboundary/i, "fence", "boundary"],
  [/\blaneway/i, "fence", "laneway"],
];

/**
 * A first guess at what a shape is, from its geometry and any words attached
 * to it. Polygons are deliberately assumed to be paddocks unless clearly
 * something else: "Dam Paddock" is a paddock, and guessing otherwise from one
 * word would be wrong more often than right.
 */
function guessKind(cls: GeomClass, name: string, group: string | null): Guess {
  const text = `${group ?? ""} ${name}`;
  if (cls === "polygon") {
    if (/\bboundary|property outline|farm outline/i.test(text)) return { kind: "boundary", subtype: null };
    if (/\btimber|exclusion|excluded/i.test(group ?? "")) return { kind: "other_area", subtype: null };
    return { kind: "paddock", subtype: null };
  }
  const rules = cls === "line" ? LINE_RULES : POINT_RULES;
  for (const [re, kind, subtype] of rules) {
    if (re.test(text)) return { kind, subtype: subtype || null };
  }
  return { kind: defaultKindFor(cls), subtype: null };
}

/**
 * This app's own exports say what each shape is — `kind` and `subtype` in the
 * GeoJSON properties or the KML ExtendedData — so a backup restores exactly
 * rather than being guessed at. Accepts the kind's id or its label.
 */
function statedKind(props: GeoJsonProperties, cls: GeomClass): Guess | null {
  const raw = props?.["kind"];
  if (typeof raw !== "string") return null;
  const want = raw.trim().toLowerCase();
  const def = KINDS.find((k) => k.id === want || k.label.toLowerCase() === want);
  if (!def || !allowsGeom(def, cls)) return null;
  const sub = props?.["subtype"];
  return { kind: def.id, subtype: typeof sub === "string" && sub.trim() ? sub.trim() : null };
}

/** Fields this app writes on export, which are not "source attributes" when read back. */
const OWN_FIELDS = new Set(["id", "kind", "subtype", "area_ha", "length_m", "rev", "source", "parent_id", "updated_at", "props"]);

function review(raws: Raw[]): { candidates: Candidate[]; rejected: Rejected[] } {
  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];

  for (const { feature, group } of raws) {
    const name = nameOf(feature.properties);
    if (!feature.geometry) {
      rejected.push({ name, group, reason: "Has no shape" });
      continue;
    }

    for (const part of explode(feature.geometry)) {
      if (part.type === "MultiPoint") {
        rejected.push({ name, group, reason: "Multi-point placemarks are not supported" });
        continue;
      }
      const cls = geomClassOf(part.type);
      if (!cls) {
        rejected.push({ name, group, reason: `${part.type} shapes are not supported` });
        continue;
      }
      let geometry: MapGeometry;
      try {
        geometry = normaliseGeometry(part);
      } catch (e) {
        const reason = e instanceof GeometryError ? e.message : "Unreadable shape";
        rejected.push({ name, group, reason });
        continue;
      }
      const stated = statedKind(feature.properties, cls);
      const guess = stated ?? guessKind(cls, name, group);

      // Our own GeoJSON carries the stored fields as a `props` object; our KML
      // flattens them into ExtendedData. Either way they come back as fields,
      // not as foreign attributes.
      const fp = feature.properties ?? {};
      let props: Record<string, unknown>;
      if (stated && fp["props"] && typeof fp["props"] === "object" && !Array.isArray(fp["props"])) {
        props = { ...(fp["props"] as Record<string, unknown>) };
      } else if (stated) {
        props = Object.fromEntries(
          Object.entries(attrsOf(fp)).filter(([k]) => !OWN_FIELDS.has(k) && k !== "name")
        );
      } else {
        props = { source_attrs: attrsOf(fp) };
      }

      candidates.push({
        i: candidates.length,
        name,
        kind: guess.kind,
        subtype: guess.subtype,
        geometry,
        ...measure(geometry),
        group,
        props,
      });
    }
  }

  // A projection mistake produces every shape rejected for the same reason;
  // raising it once reads much better than a list of hundreds.
  if (candidates.length === 0 && rejected.length > 0) {
    throw new ImportError(rejected[0]!.reason);
  }
  return { candidates, rejected };
}

/* -------------------------------- AgriWebb ------------------------------- */

/**
 * AgriWebb's map export (Farm map → export) is GeoJSON with a fixed shape:
 * every feature has `type` "paddock" or "landmark" and a `title`. Paddocks
 * carry their AgriWebb id, pasture state, crop and grazable area; landmarks a
 * `landmarkType` such as Trough or Gate. Fences are not exported at all —
 * AgriWebb only knows them as paddock edges — so they are drawn here instead.
 */
function isAgriWebbExport(fc: FeatureCollection): boolean {
  if (fc.features.length === 0) return false;
  return fc.features.every((f) => {
    const p = f.properties ?? {};
    return (p["type"] === "paddock" || p["type"] === "landmark") && typeof p["title"] === "string";
  });
}

const AGRIWEBB_LANDMARKS: Record<string, Guess> = {
  "gate": { kind: "infrastructure", subtype: "gate" },
  "water tank": { kind: "water", subtype: "tank" },
  "tank": { kind: "water", subtype: "tank" },
  "trough": { kind: "water", subtype: "trough" },
  "bore": { kind: "water", subtype: "bore" },
  "dam": { kind: "water", subtype: "dam" },
  "solar pump": { kind: "water", subtype: "pump" },
  "pump": { kind: "water", subtype: "pump" },
  "yards": { kind: "infrastructure", subtype: "yards" },
  "shed": { kind: "infrastructure", subtype: "shed" },
  "grid": { kind: "infrastructure", subtype: "grid" },
  "silo": { kind: "infrastructure", subtype: "silo" },
};

const PASTURE_STATE: Record<string, string> = {
  grazing: "grazing",
  cropping: "cultivation",
  pen: "holding",
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

function reviewAgriWebb(fc: FeatureCollection): { candidates: Candidate[]; rejected: Rejected[] } {
  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];

  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const name = String(p["title"]).trim().slice(0, 120);
    const isPaddock = p["type"] === "paddock";
    const group = isPaddock ? "Paddocks" : `Landmarks / ${String(p["landmarkType"] ?? "Other")}`;

    let geometry: MapGeometry;
    try {
      geometry = normaliseGeometry(f.geometry);
    } catch (e) {
      rejected.push({ name, group, reason: e instanceof GeometryError ? e.message : "Unreadable shape" });
      continue;
    }
    const cls = geomClassOf(geometry.type)!;

    // The AgriWebb id is kept on every feature. Grazing records exported from
    // AgriWebb name paddocks by this id, so it is how mob history will be
    // matched to paddocks here when it is brought across.
    const agriwebbId = typeof p["id"] === "string" ? p["id"] : typeof f.id === "string" ? f.id : null;

    let guess: Guess;
    const props: Record<string, unknown> = { agriwebb_id: agriwebbId };

    if (isPaddock) {
      if (cls !== "polygon") {
        rejected.push({ name, group, reason: "Paddock is not an area" });
        continue;
      }
      const state = String(p["pastureState"] ?? "").toLowerCase();
      guess = { kind: "paddock", subtype: PASTURE_STATE[state] ?? (state || null) };
      const crop = typeof p["cropType"] === "string" && p["cropType"].trim() ? p["cropType"].trim() : null;
      if (crop) props["crop"] = crop;
      const grazable = num(p["grazableArea_hectares"]);
      const area = num(p["area_hectares"]);
      // Only kept when it differs: otherwise grazable area simply follows the
      // mapped area, and stays right when the boundary is redrawn.
      if (grazable !== null && area !== null && Math.abs(grazable - area) > 0.01) {
        props["grazable_ha"] = grazable;
      }
      if (area !== null) props["agriwebb_area_ha"] = area;
    } else {
      const lt = String(p["landmarkType"] ?? "").trim();
      guess = AGRIWEBB_LANDMARKS[lt.toLowerCase()]
        ?? { kind: cls === "polygon" ? "other_area" : "infrastructure", subtype: lt.toLowerCase() || null };
      // A landmark mapped as an outline can only be a kind that allows areas.
      if (cls === "polygon" && guess.kind === "infrastructure") {
        guess = { kind: "other_area", subtype: guess.subtype };
      }
    }
    if (typeof p["fillColour"] === "string") props["colour"] = p["fillColour"];

    candidates.push({
      i: candidates.length,
      name,
      kind: guess.kind,
      subtype: guess.subtype,
      geometry,
      ...measure(geometry),
      group,
      props,
    });
  }
  return { candidates, rejected };
}
