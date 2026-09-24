/* global L */
/**
 * Mobs on the map: an icon per mob, sitting in the paddock where its head is
 * counted, showing how many head it has. Click one to open the mob; drag it
 * onto another paddock to move it.
 *
 * Several mobs in one paddock sit side by side. Agistment cattle have their
 * own colour, so whose stock is where can be seen at a glance.
 */
import { escapeHtml, featureAt, interiorPoint } from "./map.js";

// A plain cattle head: horns, ears, face. Drawn in currentColor so the pill's
// colour carries through.
const COW = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5c0 2 1.5 3 3.5 3M20 5c0 2-1.5 3-3.5 3"/><path d="M7.5 8h9l-1 8a3.5 3.5 0 0 1-7 0z"/><path d="M7.5 9.5 4 11M16.5 9.5 20 11"/><circle cx="10.5" cy="15.5" r=".6" fill="currentColor"/><circle cx="13.5" cy="15.5" r=".6" fill="currentColor"/></svg>`;

const W = 58;          // icon width, px
const W_COMPACT = 34;  // zoomed out: the head count only
const GAP = 4;
/** Below this zoom the whole property is in view and full icons crowd each other. */
const COMPACT_BELOW = 14;

export class MobLayer {
  /**
   * @param farm      the FarmMap
   * @param handlers  { canEdit, onSelect(mob), onDrop(mob, paddockFeature), isBusy() }
   */
  constructor(farm, handlers) {
    this.farm = farm;
    this.handlers = handlers;
    this.group = L.layerGroup().addTo(farm.map);
    farm.map.createPane("mobs").style.zIndex = 620; // above points, below tooltips
    this.features = [];
    this.mobs = [];
    this.compact = farm.map.getZoom() < COMPACT_BELOW;
    farm.map.on("zoomend", () => {
      const c = farm.map.getZoom() < COMPACT_BELOW;
      if (c !== this.compact) { this.compact = c; this.setMobs(this.mobs, this.features); }
    });
  }

  setMobs(mobs, features) {
    this.mobs = mobs;
    this.features = features;
    this.group.clearLayers();
    const byHome = new Map();
    for (const m of mobs) {
      const home = m.paddock_ids[0];
      if (home === undefined || m.head <= 0) continue;
      if (!byHome.has(home)) byHome.set(home, []);
      byHome.get(home).push(m);
    }
    for (const [pid, list] of byHome) {
      const f = features.find((x) => x.id === pid);
      if (!f) continue;
      const at = interiorPoint(f.geometry);
      // Largest mob in the middle of the row reads best; ties by name.
      list.sort((a, b) => b.head - a.head || a.name.localeCompare(b.name));
      list.forEach((m, i) => this.addIcon(m, at, i, list.length));
    }
  }

  addIcon(m, at, i, n) {
    // Centred row, just below the paddock's label.
    const w = this.compact ? W_COMPACT : W;
    const dx = (i - (n - 1) / 2) * (w + GAP);
    const shared = m.paddock_ids.length > 1;
    const icon = L.divIcon({
      className: "mobicon-wrap",
      html: `<div class="mobicon${m.owner ? " agist" : ""}${shared ? " shared" : ""}${this.compact ? " compact" : ""}">${this.compact ? "" : COW}<span>${m.head}</span></div>`,
      iconSize: [w, this.compact ? 18 : 24],
      iconAnchor: [w / 2 - dx, this.compact ? -6 : -10],
    });
    const marker = L.marker(at, {
      icon, pane: "mobs", draggable: this.handlers.canEdit, keyboard: true,
      title: m.name, riseOnHover: true, autoPan: true,
    });
    const where = m.paddocks.map((p) => p.name).join(" + ");
    marker.bindTooltip(
      `<b>${escapeHtml(m.name)}</b><br>${m.head} hd · ${escapeHtml(where)}${m.owner ? `<br>${escapeHtml(m.owner)}'s` : ""}`,
      { direction: "top", offset: [dx, 6] }
    );
    marker.on("click", () => {
      if (!this.handlers.isBusy()) this.handlers.onSelect(m);
    });
    // Where the pointer is, not where the marker's anchor is: the anchor sits
    // off to one side of the icon (so several fit in a row), and using it
    // would drop the mob somewhere other than under your finger.
    let pointer = null;
    const pointerLatLng = (ev) => {
      const src = ev?.touches?.[0] || ev?.changedTouches?.[0] || ev;
      if (!src || src.clientX === undefined) return null;
      return this.farm.map.mouseEventToLatLng(src);
    };
    marker.on("dragstart", () => { marker.closeTooltip(); pointer = null; });
    marker.on("drag", (e) => {
      pointer = pointerLatLng(e.originalEvent) ?? pointer;
      const f = pointer ? featureAt(this.features, pointer) : null;
      this.farm.hoverPaddock(f && f.id !== m.paddock_ids[0] ? f.id : null);
    });
    marker.on("dragend", () => {
      const dropped = pointer ?? marker.getLatLng();
      this.farm.hoverPaddock(null);
      // Always spring back: the icon moves for real once the move is saved.
      marker.setLatLng(at);
      const f = featureAt(this.features, dropped);
      if (!f) { this.handlers.onMiss?.(); return; }
      if (f.id === m.paddock_ids[0]) return;
      this.handlers.onDrop(m, f);
    });
    this.group.addLayer(marker);
  }

  setVisible(on) {
    if (on) this.group.addTo(this.farm.map);
    else this.group.remove();
  }
}
