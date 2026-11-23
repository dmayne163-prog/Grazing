/* global L */
/**
 * The rotation plan on the map: each mob's rotation paddocks filled in its own
 * colour, and a line with arrows from where it is now through the next few
 * paddocks the planner has it going to, numbered in order. The first leg
 * (the next move) is solid; the ones after are dashed, being rougher.
 */
import { escapeHtml, interiorPoint } from "./map.js";

/** Distinct colours that read over the satellite imagery. */
export const PLAN_COLOURS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#9a6324", "#aaffc3"];

/** The planned mobs in a fixed order, so each keeps its colour from one plan to the next. */
export function planMobs(plan) {
  return plan?.ok ? [...plan.mobs].sort((a, b) => Math.min(...a.mob_ids) - Math.min(...b.mob_ids)) : [];
}
export const colourOf = (i) => PLAN_COLOURS[i % PLAN_COLOURS.length];

const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

export class PlanLayer {
  constructor(farm) {
    this.farm = farm;
    const map = farm.map;
    // Fills under the paddock outlines' labels; lines and numbers above them, below the mob icons.
    if (!map.getPane("planFill")) map.createPane("planFill").style.zIndex = 405;
    if (!map.getPane("planLines")) map.createPane("planLines").style.zIndex = 445;
    this.group = L.layerGroup();
    this.on = false;
  }

  setVisible(on) {
    this.on = on;
    if (on) this.group.addTo(this.farm.map);
    else this.group.remove();
  }

  /** Draws the plan: features are the map's paddocks (for shapes and centres). */
  draw(plan, features) {
    this.group.clearLayers();
    const byId = new Map(features.map((f) => [f.id, f]));
    const centre = (id) => { const f = byId.get(id); return f ? interiorPoint(f.geometry) : null; };
    planMobs(plan).forEach((m, i) => {
      const c = colourOf(i);
      const group = m.rotation?.paddock_ids?.length ? m.rotation.paddock_ids : [...new Set([...m.paddock_ids, ...(m.pattern || []).map((s) => s.paddock_id)])];
      for (const id of group) {
        const f = byId.get(id);
        if (!f) continue;
        L.geoJSON(f.geometry, {
          pane: "planFill", interactive: false,
          style: { color: c, weight: 2, opacity: 0.9, fillColor: c, fillOpacity: m.rotation ? 0.45 : 0.25 },
        }).addTo(this.group);
      }
      // The route: where it is now, then each planned paddock in turn.
      const stops = [{ at: centre(m.paddock_ids[0]) }, ...(m.pattern || []).map((s) => ({ at: centre(s.paddock_id), s }))].filter((x) => x.at);
      for (let k = 1; k < stops.length; k++) {
        const a = stops[k - 1].at, b = stops[k].at;
        L.polyline([a, b], { pane: "planLines", color: "#111", weight: 6, opacity: 0.35, interactive: false }).addTo(this.group);
        L.polyline([a, b], { pane: "planLines", color: c, weight: 3.5, opacity: 1, dashArray: k === 1 ? null : "8 7", interactive: false }).addTo(this.group);
        arrow(a, b, c).addTo(this.group);
      }
      stops.slice(1).forEach(({ at, s }, k) => {
        L.marker(at, {
          pane: "planLines",
          icon: L.divIcon({ className: `plstop pl-c${i % PLAN_COLOURS.length}`, html: `${k + 1}`, iconSize: [20, 20] }),
          keyboard: false,
        }).bindTooltip(`<b>${escapeHtml(m.mob)}</b><br>${k + 1}. ${escapeHtml(s.name)}: ${day(s.from)} – ${day(s.to)}`, { direction: "top" })
          .addTo(this.group);
      });
    });
  }
}

/** A filled arrowhead half way along a leg, pointing the way the mob goes. */
function arrow(a, b, colour) {
  const [lat1, lng1] = a, [lat2, lng2] = b;
  const k = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  // Work in a flat frame (x east, y north, in degrees of latitude).
  const dx = (lng2 - lng1) * k, dy = lat2 - lat1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const size = Math.min(0.0028, len * 0.25); // about 300 m, smaller on a short leg
  const mx = (lng1 * k + lng2 * k) / 2, my = (lat1 + lat2) / 2;
  const tip = [my + uy * size * 0.6, mx + ux * size * 0.6];
  const back = [my - uy * size * 0.4, mx - ux * size * 0.4];
  const left = [back[0] + ux * size * 0.45, back[1] - uy * size * 0.45];
  const right = [back[0] - ux * size * 0.45, back[1] + uy * size * 0.45];
  const pts = [tip, left, right].map(([y, x]) => [y, x / k]);
  return L.polygon(pts, { pane: "planLines", color: "#111", weight: 1, fillColor: colour, fillOpacity: 1, interactive: false });
}
