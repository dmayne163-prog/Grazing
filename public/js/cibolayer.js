/**
 * Cibo's feed maps (PastureKey) laid over the farm map: total, green or dead
 * feed, ground cover, or the satellite picture, for one pass date. The tiles
 * come through this server, which holds the Cibo login.
 */
import { get } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** What the colours mean on the two layers Cibo has no legend for. */
const OWN_LEGENDS = {
  fractionalcover: "Red: bare ground · green: green cover · blue: dead cover. Brighter means more of it.",
  nbar: "The satellite's own picture of the day, in true colour.",
};

export class CiboLayer {
  constructor(farm) {
    this.farm = farm;
    this.tiles = null;
    /** What Cibo has: layers, dates (newest first), whether it's set up. Fetched once a session. */
    this.info = null;
  }

  async load() {
    if (!this.info) this.info = await get("/api/cibo/maps");
    return this.info;
  }

  show(layer, date) {
    const map = this.farm.map;
    // Over the imagery, under the paddock lines and labels.
    if (!map.getPane("ciboTiles")) map.createPane("ciboTiles").style.zIndex = 350;
    this.hide();
    const b = this.info?.bounds;
    this.tiles = L.tileLayer(`/tiles/cibo/${encodeURIComponent(layer)}/${encodeURIComponent(date)}/{z}/{x}/{y}.png`, {
      pane: "ciboTiles", opacity: 0.85, minZoom: 5, maxNativeZoom: 16, maxZoom: 22,
      ...(b ? { bounds: [[b.ymin, b.xmin], [b.ymax, b.xmax]] } : {}),
      attribution: "Pasture maps © Cibo Labs PastureKey",
    }).addTo(map);
  }

  hide() {
    if (this.tiles) { this.tiles.remove(); this.tiles = null; }
  }
}

/**
 * The tick box's controls in Layers: which map and which day, and its legend.
 * prefs: { get(key), set(key, value) } for remembering the choice on this device.
 */
export async function ciboControls(box, layer, prefs) {
  box.innerHTML = '<p class="muted tiny">Asking Cibo which days it has…</p>';
  let info;
  try { info = await layer.load(); }
  catch (e) { box.innerHTML = `<p class="muted tiny">${escapeHtml(e.message || "Couldn't reach Cibo")}</p>`; return; }
  if (!info.configured) {
    box.innerHTML = '<p class="muted tiny">Not set up yet: the server needs the Cibo API codes (CIBO_CLIENT_ID, CIBO_CLIENT_SECRET and CIBO_PROPERTY_ID in local.env).</p>';
    return;
  }
  if (!info.dates.length) { box.innerHTML = '<p class="muted tiny">Cibo has no map days for this property yet.</p>'; return; }
  const chosenLayer = info.layers.some((l) => l.id === prefs.get("ciboMap")) ? prefs.get("ciboMap") : "tsdm";
  // A remembered day that's no longer offered falls back to the newest.
  const chosenDate = info.dates.includes(prefs.get("ciboDate")) ? prefs.get("ciboDate") : info.dates[0];
  box.innerHTML = `
    <div class="f"><label for="ciboMap">Map</label><select id="ciboMap">${info.layers.map((l) => `<option value="${escapeHtml(l.id)}"${l.id === chosenLayer ? " selected" : ""}>${escapeHtml(l.label)}</option>`).join("")}</select></div>
    <div class="f"><label for="ciboDate">Satellite pass</label><select id="ciboDate">${info.dates.map((d, i) => `<option value="${d}"${d === chosenDate ? " selected" : ""}>${day(d)}${i === 0 ? " (newest)" : ""}</option>`).join("")}</select></div>
    <div class="cibolegend small" id="ciboLegend"></div>
    <p class="muted tiny">Cibo's 10 m map for one pass: it shows where the feed is within a paddock. Cloudy passes have gaps.</p>`;
  const mapSel = box.querySelector("#ciboMap");
  const dateSel = box.querySelector("#ciboDate");
  const redraw = async () => {
    prefs.set("ciboMap", mapSel.value);
    prefs.set("ciboDate", dateSel.value);
    layer.show(mapSel.value, dateSel.value);
    await legend(box.querySelector("#ciboLegend"), mapSel.value);
  };
  mapSel.onchange = redraw;
  dateSel.onchange = redraw;
  await redraw();
}

/** Cibo's legend for a layer: a strip of its colours with the labels under it. */
async function legend(el, id) {
  if (OWN_LEGENDS[id]) { el.innerHTML = `<p class="muted tiny">${OWN_LEGENDS[id]}</p>`; return; }
  let lg = null;
  try { lg = await get(`/api/cibo/legend/${encodeURIComponent(id)}`); } catch { /* none */ }
  const items = lg?.legend || [];
  if (!items.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="tiny muted">${escapeHtml(lg.title || "")}</div>
    <div class="ciboscale">${items.map((it) => `<span class="cibokey"><i class="swatch" data-rgb="${(it.color || []).slice(0, 3).join(",")}"></i>${escapeHtml(String(it.label ?? ""))}</span>`).join("")}</div>`;
  // Through the CSSOM: the CSP allows that, not style attributes.
  el.querySelectorAll("[data-rgb]").forEach((sw) => { sw.style.background = `rgb(${sw.dataset.rgb})`; });
}
