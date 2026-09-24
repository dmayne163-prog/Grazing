/* global L */
/**
 * The map itself: imagery, one layer group per kind of feature, styling,
 * paddock labels, selection and "where am I".
 *
 * Features are drawn from the GeoJSON the server returns, and each Leaflet
 * layer keeps a reference to its feature (`layer.feature`) so the editor can
 * read and write it back without a lookup table.
 */

const COLOURS = {
  paddock: "#F2E8C9",
  cultivation: "#E0A845",
  holding: "#9AA5AA",
  boundary: "#E4695E",
  other: "#9AA5AA",
  fence: "#E0A845",
  electric: "#FFE14D",
  track: "#C9A27A",
  pipeline: "#6F8FE0",
  water: "#4FC3F7",
  tank: "#2E86DE",
  bore: "#A48CF5",
  infra: "#F08A4B",
  selected: "#4FA9D6",
};

/** The swatch colour for a kind, for lists and legends. */
export function kindColour(kind, subtype) {
  switch (kind) {
    case "paddock": return subtype === "cultivation" ? COLOURS.cultivation : COLOURS.paddock;
    case "boundary": return COLOURS.boundary;
    case "other_area": return COLOURS.other;
    case "fence": return subtype === "electric" ? COLOURS.electric : subtype === "boundary" ? COLOURS.boundary : COLOURS.fence;
    case "track": return COLOURS.track;
    case "pipeline": return COLOURS.pipeline;
    case "water": return subtype === "tank" ? COLOURS.tank : subtype === "bore" || subtype === "pump" ? COLOURS.bore : COLOURS.water;
    case "infrastructure": return COLOURS.infra;
    default: return COLOURS.other;
  }
}

function pathStyle(f, selected) {
  const { kind, subtype } = f.properties;
  const colour = kindColour(kind, subtype);
  let s;
  switch (kind) {
    case "paddock":
      s = openGroup.has(f.id)
        // Open into another paddock: green, like an open gate, so a set of
        // paddocks with the gates open between them reads as one.
        ? { color: OPEN, weight: 3, opacity: 1, fillColor: OPEN, fillOpacity: 0.16 }
        : {
          color: colour, weight: 1.6, opacity: 0.95,
          fillColor: colour,
          fillOpacity: subtype === "cultivation" || subtype === "holding" ? 0.12 : 0.03,
        };
      break;
    case "boundary":
      s = { color: colour, weight: 3, dashArray: "10 6", fill: false };
      break;
    case "other_area":
      s = { color: colour, weight: 1, fillColor: colour, fillOpacity: 0.22 };
      break;
    case "water": // a dam mapped as its outline
      s = { color: "#fff", weight: 1, fillColor: colour, fillOpacity: 0.55 };
      break;
    case "fence":
      s = {
        color: colour,
        weight: subtype === "boundary" ? 3.2 : 2.2,
        dashArray: subtype === "electric" ? "6 5" : subtype === "temporary" ? "2 5" : null,
      };
      break;
    case "track":
      s = { color: colour, weight: 2, dashArray: "2 6" };
      break;
    case "pipeline":
      s = { color: colour, weight: 2, dashArray: "5 4" };
      break;
    default:
      s = { color: colour, weight: 1.5 };
  }
  if (selected) {
    s = { ...s, color: COLOURS.selected, weight: (s.weight || 2) + 2, opacity: 1 };
    if (s.fill !== false) s.fillOpacity = Math.max(s.fillOpacity || 0, 0.15);
    if (s.fillColor) s.fillColor = COLOURS.selected;
  }
  return s;
}

/** Gate id → "open" | "closed", set from the server. */
let gateStates = new Map();

/** Paddock id → the other paddocks it is open into. */
let openGroup = new Map();
const OPEN = "#5FBE8E";

function pointStyle(f, selected) {
  const { kind, subtype } = f.properties;
  const openGate = subtype === "gate" && gateStates.get(f.id) === "open";
  const colour = openGate ? OPEN : kindColour(kind, subtype);
  const radius = openGate ? 5.5 : kind === "infrastructure" && subtype === "gate" ? 3.5
    : subtype === "tank" || subtype === "bore" || subtype === "dam" ? 6
    : 5;
  return {
    radius: selected ? radius + 3 : radius,
    color: selected ? COLOURS.selected : "#fff",
    weight: selected ? 3 : 1.2,
    fillColor: colour,
    fillOpacity: 1,
  };
}

/** Draw order: areas at the bottom, lines over them, points on top. */
const LAYER_ORDER = ["boundary", "other_area", "paddock", "track", "pipeline", "fence", "water", "infrastructure"];

export class FarmMap {
  constructor(el, meta, handlers) {
    this.meta = meta;
    this.handlers = handlers;
    this.layersById = new Map();
    this.groups = new Map();
    this.hidden = new Set(loadHidden());
    this.selectedId = null;

    this.map = L.map(el, {
      center: meta.mapCentre,
      zoom: meta.mapZoom,
      zoomControl: true,
      preferCanvas: false,
      // Past the imagery's own resolution the tiles are stretched rather than
      // going grey, which is what you want when placing a trough precisely.
      maxZoom: 21,
    });
    this.map.attributionControl.setPrefix(false);

    // Points go above lines and areas regardless of the order they were added.
    this.map.createPane("points").style.zIndex = 450;

    this.baseLayers = {};
    for (const src of meta.tileSources) {
      this.baseLayers[src.label] = L.tileLayer(`/tiles/${src.id}/{z}/{x}/{y}`, {
        maxNativeZoom: src.maxZoom,
        maxZoom: 21,
        attribution: src.attribution,
        // Tiles are served by this app, so a failed one is worth retrying on
        // the next pan rather than being cached as broken by Leaflet.
        crossOrigin: false,
      });
    }
    const saved = localGet("baseLayer");
    const initial = this.baseLayers[saved] || Object.values(this.baseLayers)[0];
    initial.addTo(this.map);
    L.control.layers(this.baseLayers, null, { position: "bottomleft" }).addTo(this.map);
    this.map.on("baselayerchange", (e) => localSet("baseLayer", e.name));

    for (const kind of LAYER_ORDER) {
      const g = L.featureGroup();
      this.groups.set(kind, g);
      if (!this.hidden.has(kind)) g.addTo(this.map);
    }

    // Labels only once zoomed in far enough to read them without clutter.
    const updateLabels = () => {
      el.classList.toggle("hide-labels", this.map.getZoom() < 13);
    };
    this.map.on("zoomend", updateLabels);
    updateLabels();

    this.map.on("click", (e) => {
      // A click on empty map clears the selection; clicks on features stop
      // propagation before they reach here.
      if (!this.handlers.isBusy()) this.handlers.onMapClick?.(e);
    });
  }

  /* ------------------------------- features ------------------------------ */

  setFeatures(features) {
    for (const g of this.groups.values()) g.clearLayers();
    this.layersById.clear();
    for (const f of features) this.addFeature(f);
    if (this.selectedId !== null) this.highlight(this.selectedId);
  }

  makeLayer(f) {
    const selected = f.id === this.selectedId;
    let layer;
    if (f.geometry.type === "Point") {
      const [lon, lat] = f.geometry.coordinates;
      layer = L.circleMarker([lat, lon], { ...pointStyle(f, selected), pane: "points" });
    } else {
      layer = L.geoJSON(f, { style: () => pathStyle(f, selected) }).getLayers()[0];
    }
    layer.feature = f;

    if (f.properties.kind === "paddock" && f.properties.name) {
      const ha = f.properties.area_ha != null ? ` <span class="ha">${Math.round(f.properties.area_ha)} ha</span>` : "";
      // Standalone rather than bound to the polygon: a bound label sits at the
      // polygon's centroid, which for an L-shaped paddock is outside it.
      layer._label = L.tooltip({ permanent: true, direction: "center", className: "plabel", interactive: false })
        .setLatLng(interiorPoint(f.geometry))
        .setContent(`${escapeHtml(f.properties.name)}${ha}`);
    } else if (f.properties.name) {
      layer.bindTooltip(escapeHtml(f.properties.name), { direction: "top", offset: [0, -6] });
    }

    layer.on("click", (e) => {
      // While drawing, the click must carry on to the map: that is where the
      // editor places its points, and a fence drawn across a paddock is
      // clicked entirely inside it.
      if (this.handlers.isBusy()) return;
      L.DomEvent.stopPropagation(e);
      this.handlers.onSelect(f.id);
    });
    return layer;
  }

  addFeature(f) {
    const g = this.groups.get(f.properties.kind);
    if (!g) return;
    const layer = this.makeLayer(f);
    g.addLayer(layer);
    if (layer._label) g.addLayer(layer._label);
    this.layersById.set(f.id, layer);
  }

  /** Replaces one feature's layer after it was saved. */
  replaceFeature(f) {
    this.removeFeature(f.id);
    this.addFeature(f);
    if (f.id === this.selectedId) this.highlight(f.id);
  }

  removeFeature(id) {
    const layer = this.layersById.get(id);
    if (!layer) return;
    for (const g of this.groups.values()) {
      g.removeLayer(layer);
      if (layer._label) g.removeLayer(layer._label);
    }
    this.layersById.delete(id);
  }

  layerFor(id) {
    return this.layersById.get(id) || null;
  }

  /* ------------------------------- selection ----------------------------- */

  highlight(id) {
    const prev = this.selectedId !== null ? this.layersById.get(this.selectedId) : null;
    if (prev) restyle(prev, false);
    this.selectedId = id;
    const layer = id !== null ? this.layersById.get(id) : null;
    if (layer) {
      restyle(layer, true);
      if (layer.bringToFront && layer.feature.geometry.type !== "Point") layer.bringToFront();
    }
  }

  zoomTo(id) {
    const layer = this.layersById.get(id);
    if (!layer) return;
    if (layer.getBounds) {
      this.map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 17 });
    } else {
      this.map.setView(layer.getLatLng(), Math.max(this.map.getZoom(), 16));
    }
  }

  fitAll() {
    const all = L.featureGroup([...this.layersById.values()]);
    if (all.getLayers().length === 0) return false;
    this.map.fitBounds(all.getBounds(), { padding: [20, 20] });
    return true;
  }

  /* -------------------------------- gates -------------------------------- */

  setGateStates(list) {
    gateStates = new Map(list.map((g) => [g.gate_id, g.state]));
    for (const layer of this.layersById.values()) {
      if (layer.feature.properties.subtype === "gate") restyle(layer, layer.feature.id === this.selectedId);
    }
  }

  /** Paddocks open into each other; see openGroups() in main.js. */
  setOpenGroups(map) {
    const changed = new Set([...openGroup.keys(), ...map.keys()]);
    openGroup = map;
    for (const id of changed) {
      const layer = this.layersById.get(id);
      if (layer) restyle(layer, id === this.selectedId);
    }
    // On top of their neighbours, or a shared fence is drawn in the
    // neighbour's colour and the green edge is lost along it.
    for (const id of openGroup.keys()) this.layersById.get(id)?.bringToFront();
    if (this.selectedId !== null) this.layersById.get(this.selectedId)?.bringToFront?.();
  }

  /* ----------------------------- drop target ------------------------------ */

  /** Outlines the paddock a mob is being dragged over; null clears it. */
  hoverPaddock(id) {
    if (this._hover === id) return;
    const prev = this._hover != null ? this.layersById.get(this._hover) : null;
    if (prev) restyle(prev, prev.feature.id === this.selectedId);
    this._hover = id;
    const layer = id != null ? this.layersById.get(id) : null;
    if (layer) layer.setStyle({ color: "#5FBE8E", weight: 4, fillColor: "#5FBE8E", fillOpacity: 0.18, dashArray: "8 5" });
  }

  /* ------------------------------ visibility ----------------------------- */

  setKindVisible(kind, visible) {
    const g = this.groups.get(kind);
    if (!g) return;
    if (visible) { this.hidden.delete(kind); g.addTo(this.map); }
    else { this.hidden.add(kind); g.remove(); }
    localSet("hiddenKinds", JSON.stringify([...this.hidden]));
  }

  isKindVisible(kind) {
    return !this.hidden.has(kind);
  }

  /* ------------------------------ where am I ----------------------------- */

  startLocating(onUpdate, onError) {
    this.stopLocating();
    this.locating = true;
    let first = true;
    this.map.on("locationfound", (this._onFound = (e) => {
      if (!this.locMarker) {
        this.locAccuracy = L.circle(e.latlng, { radius: e.accuracy, color: "#4FA9D6", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(this.map);
        this.locMarker = L.circleMarker(e.latlng, { radius: 7, color: "#fff", weight: 2, fillColor: "#4FA9D6", fillOpacity: 1, pane: "points", interactive: false }).addTo(this.map);
      } else {
        this.locMarker.setLatLng(e.latlng);
        this.locAccuracy.setLatLng(e.latlng).setRadius(e.accuracy);
      }
      if (first) {
        this.map.setView(e.latlng, Math.max(this.map.getZoom(), 15));
        first = false;
      }
      onUpdate(e.latlng, e.accuracy);
    }));
    this.map.on("locationerror", (this._onErr = (e) => onError(e.message)));
    this.map.locate({ watch: true, enableHighAccuracy: true, setView: false });
  }

  stopLocating() {
    if (!this.locating) return;
    this.map.stopLocate();
    this.map.off("locationfound", this._onFound);
    this.map.off("locationerror", this._onErr);
    this.locMarker?.remove();
    this.locAccuracy?.remove();
    this.locMarker = this.locAccuracy = null;
    this.locating = false;
  }
}

function restyle(layer, selected) {
  const f = layer.feature;
  if (f.geometry.type === "Point") layer.setStyle(pointStyle(f, selected));
  else layer.setStyle(pathStyle(f, selected));
}

/* ------------------------------ interior point ----------------------------- */

// Keyed by the geometry object: a saved edit arrives as a new object, so a
// reshaped paddock is recomputed and an unchanged one is not.
const interiorCache = new WeakMap();

/**
 * A point well inside a polygon, for its label and its mobs — the centroid
 * falls outside an L- or C-shaped paddock. A coarse grid search for the
 * spot furthest from any edge, refined once around the best cell: plenty for
 * placing a label, and cheap for fifty paddocks.
 */
export function interiorPoint(geometry) {
  if (interiorCache.has(geometry)) return interiorCache.get(geometry);
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  // The largest part, by bounding box.
  let best = polys[0];
  let bestSpan = -1;
  for (const p of polys) {
    const xs = p[0].map((c) => c[0]), ys = p[0].map((c) => c[1]);
    const span = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (span > bestSpan) { bestSpan = span; best = p; }
  }
  const ring = best[0];
  const kx = Math.cos((ring[0][1] * Math.PI) / 180);
  const edgeDist = (x, y) => {
    let d = Infinity;
    for (const r of best) {
      for (let i = 1; i < r.length; i++) {
        const [ax, ay] = r[i - 1], [bx, by] = r[i];
        const dx = (bx - ax) * kx, dy = by - ay;
        const px = (x - ax) * kx, py = y - ay;
        const len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, (px * dx + py * dy) / len)) : 0;
        d = Math.min(d, Math.hypot(px - t * dx, py - t * dy));
      }
    }
    return d;
  };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  let pick = null, pickD = -1;
  const search = (x0, x1, y0, y1, n) => {
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * j) / n;
      if (!inPolygon(x, y, best)) continue;
      const d = edgeDist(x, y);
      if (d > pickD) { pickD = d; pick = [x, y]; }
    }
  };
  search(minX, maxX, minY, maxY, 16);
  if (pick) {
    const wx = (maxX - minX) / 16, wy = (maxY - minY) / 16;
    search(pick[0] - wx, pick[0] + wx, pick[1] - wy, pick[1] + wy, 8);
  }
  const out = pick ? [pick[1], pick[0]] : [(minY + maxY) / 2, (minX + maxX) / 2];
  interiorCache.set(geometry, out);
  return out;
}

/* ----------------------------- point in polygon ---------------------------- */

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon, lat, rings) {
  if (!inRing(lon, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(lon, lat, rings[k])) return false;
  return true;
}

/** The feature (of the given kind) containing a point, if any. */
export function featureAt(features, latlng, kind = "paddock") {
  const { lng, lat } = latlng;
  for (const f of features) {
    if (f.properties.kind !== kind) continue;
    const g = f.geometry;
    if (g.type === "Polygon" && inPolygon(lng, lat, g.coordinates)) return f;
    if (g.type === "MultiPolygon" && g.coordinates.some((p) => inPolygon(lng, lat, p))) return f;
  }
  return null;
}

/* --------------------------------- helpers --------------------------------- */

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Storage can throw (private mode, blocked site data); a preference is never
// worth breaking the page over.
export function localGet(key) {
  try { return localStorage.getItem(`grazing.${key}`); } catch { return null; }
}
export function localSet(key, value) {
  try { localStorage.setItem(`grazing.${key}`, value); } catch { /* ignore */ }
}
function loadHidden() {
  try { return JSON.parse(localGet("hiddenKinds") || "[]"); } catch { return []; }
}
