/* global L */
/**
 * Drawing and reshaping, on top of Leaflet-Geoman.
 *
 * Geoman's own toolbar is not used: its buttons are about shapes ("polygon",
 * "polyline"), while the question here is always about the farm ("a fence",
 * "a trough"). So the editor takes a kind, works out the shape from it, and
 * hands back plain GeoJSON geometry — the rest of the app never touches
 * Geoman directly.
 *
 * Snapping is on everywhere. A fence drawn along an existing paddock edge
 * snaps to its corners and sides, which is what keeps the map from filling
 * up with slivers and near-miss gaps.
 */

const SHAPE = { polygon: "Polygon", line: "Line", point: "CircleMarker" };

export class Editor {
  constructor(map) {
    this.map = map;
    map.pm.setGlobalOptions({
      snappable: true,
      snapDistance: 18,
      allowSelfIntersection: false,
      // A vertex is removed with a right-click (or long-press on a phone),
      // rather than geoman's default of any click on it, which is far too
      // easy to do by accident on a touchscreen.
      removeVertexOn: "contextmenu",
      templineStyle: { color: "#4FA9D6", weight: 2 },
      hintlineStyle: { color: "#4FA9D6", dashArray: [5, 5] },
      pathOptions: { color: "#4FA9D6", weight: 2.5, fillOpacity: 0.12 },
      markerStyle: { draggable: true },
    });
    this.active = null;
  }

  get busy() {
    return this.active !== null;
  }

  /**
   * Starts drawing a new shape of the given class. Resolves with the drawn
   * layer's GeoJSON geometry, or null if it was cancelled.
   */
  draw(geomClass) {
    this.cancel();
    return new Promise((resolve) => {
      const onCreate = (e) => {
        this.map.off("pm:create", onCreate);
        const geometry = e.layer.toGeoJSON().geometry;
        this.active = { type: "draw", layer: e.layer, resolve: null };
        resolve({ geometry, layer: e.layer });
      };
      this.map.on("pm:create", onCreate);
      this.active = {
        type: "draw",
        layer: null,
        resolve: () => {
          this.map.off("pm:create", onCreate);
          resolve(null);
        },
      };
      this.map.pm.enableDraw(SHAPE[geomClass], {
        continueDrawing: false,
        finishOn: geomClass === "point" ? null : "dblclick",
      });
    });
  }

  /** Lets the vertices of an existing layer be moved. */
  reshape(layer) {
    this.cancel();
    this.active = { type: "edit", layer, resolve: null };
    if (layer.pm) layer.pm.enable({ snappable: true, draggable: layer instanceof L.CircleMarker });
    if (layer.bringToFront) layer.bringToFront();
  }

  /** The geometry of the layer currently being reshaped. */
  currentGeometry() {
    return this.active?.layer ? this.active.layer.toGeoJSON().geometry : null;
  }

  /**
   * Ends whatever is in progress. A freshly drawn but unsaved layer is removed;
   * a reshaped layer is left for the caller to redraw from the saved feature.
   */
  cancel() {
    const a = this.active;
    this.active = null;
    this.map.pm.disableDraw();
    if (!a) return;
    if (a.resolve) a.resolve();
    if (a.type === "draw" && a.layer) a.layer.remove();
    if (a.type === "edit" && a.layer?.pm) a.layer.pm.disable();
  }

  /** Finishes without discarding anything — the caller has saved it. */
  finish() {
    const a = this.active;
    this.active = null;
    this.map.pm.disableDraw();
    if (!a) return;
    if (a.type === "draw" && a.layer) a.layer.remove();
    if (a.type === "edit" && a.layer?.pm) a.layer.pm.disable();
  }
}
