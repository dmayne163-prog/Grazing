/**
 * What a map feature can be.
 *
 * Kept deliberately short. Every kind here is something the grazing side of
 * the app will eventually reason about — paddock areas feed stocking rates,
 * water points decide which paddocks can be used in a dry spell, fences
 * decide what a mob can reach — so a kind is only added when something will
 * use it. Anything else fits in `other_area` or `infrastructure` with a note.
 */

export type GeomClass = "polygon" | "line" | "point";

export interface KindDef {
  id: string;
  label: string;
  /** Shapes it may be drawn as. The first is what the draw tool uses. */
  geoms: GeomClass[];
  /** Suggested subtypes. Free text is accepted too; these are just the picker. */
  subtypes: string[];
}

export const KINDS: KindDef[] = [
  {
    id: "paddock",
    label: "Paddock",
    geoms: ["polygon"],
    subtypes: ["grazing", "cultivation", "holding", "laneway paddock", "house paddock"],
  },
  { id: "boundary", label: "Property boundary", geoms: ["polygon"], subtypes: [] },
  {
    id: "other_area",
    label: "Other area",
    geoms: ["polygon"],
    subtypes: ["timber", "exclusion", "dam", "yards", "house", "sheds"],
  },
  {
    id: "fence",
    label: "Fence",
    geoms: ["line"],
    subtypes: ["boundary", "internal", "electric", "laneway", "exclusion", "temporary"],
  },
  { id: "track", label: "Track / road", geoms: ["line"], subtypes: ["road", "track", "firebreak"] },
  { id: "pipeline", label: "Water pipeline", geoms: ["line"], subtypes: ["poly", "steel"] },
  {
    id: "water",
    label: "Water point",
    // A dam is often mapped as its outline rather than a pin.
    geoms: ["point", "polygon"],
    subtypes: ["trough", "tank", "bore", "dam", "pump", "creek", "turkey nest"],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    geoms: ["point"],
    subtypes: ["gate", "yards", "grid", "shed", "silo", "lick station", "rain gauge"],
  },
];

export const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

export function geomClassOf(type: string): GeomClass | null {
  switch (type) {
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    case "LineString":
    case "MultiLineString":
      return "line";
    case "Point":
      return "point";
    default:
      return null;
  }
}

export function allowsGeom(k: KindDef, cls: GeomClass): boolean {
  return k.geoms.includes(cls);
}

/** The kind a freshly imported shape should start as, before anyone reviews it. */
export function defaultKindFor(geom: GeomClass): string {
  return geom === "polygon" ? "paddock" : geom === "line" ? "fence" : "water";
}
