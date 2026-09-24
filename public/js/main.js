/* global L */
import { get, send } from "./api.js";
import { Editor } from "./editor.js";
import { openImport } from "./importer.js";
import { downloadTiles, offlineSupported, tilesFor } from "./offline.js";
import { renderRain } from "./rain.js";
import { escapeHtml, FarmMap, featureAt, kindColour, localGet, localSet } from "./map.js";

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  meta: null,
  features: [],
  byId: new Map(),
  selectedId: null,
  tab: localGet("tab") || "paddocks",
  sort: { key: "name", dir: 1 },
  /** null when idle; otherwise what the map is being used for. */
  mode: null,
  offlineRun: null,
  /** Current mobs, and stock per paddock id, from the server. */
  mobs: [],
  stock: new Map(),
  selectedMobId: null,
  /** Rest and use per paddock id, and when the stock records begin. */
  grazing: new Map(),
  recordsBegin: null,
};

let farm, editor;

/* --------------------------------- format ---------------------------------- */

const nf1 = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const ha = (v) => (v == null ? "—" : `${v >= 100 ? nf0.format(v) : nf1.format(v)} ha`);
const km = (m) => (m == null ? "—" : m >= 1000 ? `${nf1.format(m / 1000)} km` : `${nf0.format(m)} m`);
const when = (ts) => new Date(ts).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

const kindDef = (id) => state.meta.kinds.find((k) => k.id === id);
const kindLabel = (id) => kindDef(id)?.label || id;
const canEdit = () => state.meta.canEdit;

/** Grazable area if one was set, otherwise the mapped area. */
const grazable = (f) => {
  const g = Number(f.properties.props?.grazable_ha);
  return Number.isFinite(g) && g > 0 ? g : f.properties.area_ha;
};

/* ---------------------------------- toast ---------------------------------- */

let toastTimer;
function toast(message, { error = false, action = null, ms = 4500 } = {}) {
  const el = $("#toast");
  el.className = `toast${error ? " err" : ""}`;
  el.innerHTML = `<span>${escapeHtml(message)}</span>${action ? `<button>${escapeHtml(action.label)}</button>` : ""}`;
  el.hidden = false;
  if (action) el.querySelector("button").onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? ms * 2 : ms);
}

/* ---------------------------------- data ----------------------------------- */

async function loadFeatures() {
  const fc = await get("/api/features");
  setFeatures(fc.features);
}

async function loadStock() {
  try {
    const [mobs, stock, grazing] = await Promise.all([get("/api/mobs"), get("/api/stock"), get("/api/grazing")]);
    state.mobs = mobs;
    state.stock = new Map(stock.map((s) => [s.paddock_id, s]));
    state.grazing = new Map(grazing.paddocks.map((g) => [g.paddock_id, g]));
    state.recordsBegin = grazing.records_begin;
  } catch {
    // The map is still worth showing without the stock on it.
  }
}

const mobById = (id) => state.mobs.find((m) => m.id === id);
const ownHead = (mobs) => mobs.filter((m) => !m.owner).reduce((s, m) => s + m.head, 0);
const agistHead = (mobs) => mobs.filter((m) => m.owner).reduce((s, m) => s + m.head, 0);
const kg = (v) => (v == null ? "—" : `${nf0.format(v)} kg`);
const day = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
const shortDay = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "now";

/**
 * Days a paddock has been rested, for sorting and the list. In use sorts
 * first as -1; never grazed since records began sorts last, as the longest rest.
 */
function restOf(id) {
  const g = state.grazing.get(id);
  if (!g) return state.recordsBegin ? Number.MAX_SAFE_INTEGER : null;
  return g.occupied ? -1 : g.rest_days;
}
function restLabel(id) {
  const r = restOf(id);
  if (r === null) return "";
  if (r === -1) return '<span class="inuse">in use</span>';
  if (r === Number.MAX_SAFE_INTEGER) return `<span class="muted" title="Not grazed since records began, ${day(state.recordsBegin)}">none recorded</span>`;
  return `${r} d`;
}

function setFeatures(features) {
  state.features = features;
  state.byId = new Map(features.map((f) => [f.id, f]));
  if (state.selectedId !== null && !state.byId.has(state.selectedId)) state.selectedId = null;
  farm.setFeatures(features);
  refreshSearch();
}

function upsert(f) {
  const i = state.features.findIndex((x) => x.id === f.id);
  if (i >= 0) state.features[i] = f;
  else state.features.push(f);
  state.byId.set(f.id, f);
  farm.replaceFeature(f);
  refreshSearch();
}

function drop(id) {
  state.features = state.features.filter((f) => f.id !== id);
  state.byId.delete(id);
  farm.removeFeature(id);
  refreshSearch();
}

/* --------------------------------- search ---------------------------------- */

function refreshSearch() {
  const names = state.features
    .filter((f) => f.properties.name)
    .map((f) => `<option value="${escapeHtml(f.properties.name)}">${escapeHtml(kindLabel(f.properties.kind))}</option>`);
  $("#searchList").innerHTML = names.join("");
}

function onSearch() {
  const q = $("#search").value.trim().toLowerCase();
  if (!q) return;
  const hit = state.features.find((f) => f.properties.name.toLowerCase() === q)
    || state.features.find((f) => f.properties.name.toLowerCase().startsWith(q));
  if (hit) {
    select(hit.id, { zoom: true });
    $("#search").blur();
  }
}

/* -------------------------------- selection -------------------------------- */

function select(id, { zoom = false } = {}) {
  if (state.mode) return;
  state.selectedMobId = null;
  state.selectedId = id;
  farm.highlight(id);
  if (id !== null && zoom) farm.zoomTo(id);
  if (id !== null) openSheet(true);
  render();
}

function openSheet(open) {
  document.querySelector(".app").classList.toggle("sheet-open", open);
  // The map's size changes with the sheet on a phone.
  setTimeout(() => farm.map.invalidateSize(), 220);
}

/* ---------------------------------- modes ---------------------------------- */

function setMode(mode, text, { canSave = false } = {}) {
  state.mode = mode;
  $("#modebar").hidden = !mode;
  $("#modeText").textContent = text || "";
  $("#modeDone").hidden = !canSave;
  document.querySelectorAll("#tools button").forEach((b) => {
    b.setAttribute("aria-pressed", String(mode === "draw" && b.dataset.draw === state.drawKind));
  });
}

function endMode() {
  setMode(null);
  state.drawKind = null;
  document.querySelectorAll("#tools button").forEach((b) => b.setAttribute("aria-pressed", "false"));
}

const DRAW_HINT = {
  polygon: "Click each corner; click the first corner (or double-click) to close it.",
  line: "Click along the line; double-click the last point to finish.",
  point: "Click where it is.",
};

async function startDraw(kindId) {
  const def = kindDef(kindId);
  if (!def) return;
  if (state.mode) cancelMode();
  select(null);
  const geom = def.geoms[0];
  state.drawKind = kindId;
  setMode("draw", `New ${def.label.toLowerCase()}: ${DRAW_HINT[geom]}`);
  const result = await editor.draw(geom);
  if (!result) return; // cancelled
  setMode("new", `New ${def.label.toLowerCase()} — fill in the details to save it.`);
  renderNew(def, result.geometry);
  openSheet(true);
}

function cancelMode() {
  const wasEditing = state.mode === "reshape";
  editor.cancel();
  endMode();
  // A reshaped layer is left mid-edit by the editor; redraw it from the
  // saved feature to throw the unsaved changes away.
  if (wasEditing && state.selectedId !== null) {
    const f = state.byId.get(state.selectedId);
    if (f) farm.replaceFeature(f);
  }
  render();
}

function startReshape() {
  const f = state.byId.get(state.selectedId);
  const layer = farm.layerFor(state.selectedId);
  if (!f || !layer) return;
  const point = f.geometry.type === "Point";
  setMode(
    "reshape",
    point
      ? "Drag the point to move it."
      : "Drag corners to move them; drag a mid-point to add one; right-click or long-press a corner to remove it.",
    { canSave: true }
  );
  editor.reshape(layer);
}

async function saveReshape() {
  const f = state.byId.get(state.selectedId);
  const geometry = editor.currentGeometry();
  if (!f || !geometry) return;
  try {
    const saved = await send("PUT", `/api/features/${f.id}`, {
      ...featureBody(f), geometry, rev: f.properties.rev,
    });
    editor.finish();
    endMode();
    upsert(saved);
    farm.highlight(saved.id);
    render();
    toast(saved.properties.area_ha != null ? `Shape saved — now ${ha(saved.properties.area_ha)}` : "Shape saved");
  } catch (e) {
    toast(e.message, { error: true });
  }
}

async function startSplit() {
  const f = state.byId.get(state.selectedId);
  if (!f) return;
  editor.cancel();
  setMode("split", `Draw the new part of ${f.properties.name || "this paddock"}. You can overshoot the boundary; only the part inside counts.`);
  const result = await editor.draw("polygon");
  if (!result) return;
  setMode("split-name", "Name the new paddock to finish the split.");
  renderSplitName(f, result.geometry);
  openSheet(true);
}

/* ---------------------------------- panel ---------------------------------- */

function render() {
  const body = $("#panelBody");
  if (state.mode === "new" || state.mode === "split-name") return; // their own forms are showing
  const mob = state.selectedMobId !== null ? mobById(state.selectedMobId) : null;
  if (mob) {
    body.innerHTML = mobHtml(mob);
    bindMob(mob);
    return;
  }
  const f = state.selectedId !== null ? state.byId.get(state.selectedId) : null;
  body.innerHTML = f ? featureHtml(f) : overviewHtml();
  if (f) bindFeature(f);
  else bindOverview();
}

function selectMob(id) {
  if (state.mode) return;
  state.selectedId = null;
  farm.highlight(null);
  state.selectedMobId = id;
  const m = mobById(id);
  if (m && m.paddocks.length) {
    const layers = m.paddocks.map((p) => farm.layerFor(p.id)).filter(Boolean);
    if (layers.length) farm.map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [40, 40], maxZoom: 15 });
  }
  openSheet(true);
  render();
}

/* overview */

function overviewHtml() {
  const paddocks = state.features.filter((f) => f.properties.kind === "paddock");
  const water = state.features.filter((f) => f.properties.kind === "water");
  const total = paddocks.reduce((s, f) => s + (grazable(f) || 0), 0);
  const own = ownHead(state.mobs);
  const agist = agistHead(state.mobs);

  const tabs = [
    ["paddocks", "Paddocks"], ["mobs", "Mobs"], ["rain", "Rain"], ["water", "Water"], ["layers", "Layers"], ["tools", "Tools"],
  ];

  let content = "";
  if (state.features.length === 0) {
    content = `<div class="note">The map is empty. ${canEdit()
      ? "Import your AgriWebb map export from <b>Tools</b>, or start drawing paddocks with the buttons on the map."
      : "An administrator needs to import or draw the paddocks."}</div>`;
  }

  if (state.tab === "paddocks") content += paddockTable(paddocks);
  if (state.tab === "mobs") content += mobsTable();
  if (state.tab === "rain") content += `<div id="rainTab"><p class="muted small">Loading…</p></div>`;
  if (state.tab === "water") content += waterTable(water);
  if (state.tab === "layers") content += layersHtml();
  if (state.tab === "tools") content += toolsHtml();

  return `
    <h2>${escapeHtml(state.meta.propertyName)}</h2>
    <div class="stats">
      <div class="stat"><b>${paddocks.length}</b><span>paddocks</span></div>
      <div class="stat"><b>${nf0.format(total)}</b><span>grazable ha</span></div>
      <div class="stat"><b>${nf0.format(own + agist)}</b><span>head${agist ? ` · ${nf0.format(agist)} agisted` : ""}</span></div>
    </div>
    <div class="tabs" role="tablist">
      ${tabs.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}</button>`).join("")}
    </div>
    ${content}`;
}

function paddockTable(paddocks) {
  if (paddocks.length === 0) return "";
  const { key, dir } = state.sort;
  const head = (f) => state.stock.get(f.id)?.head || 0;
  const val = (f) => key === "ha" ? grazable(f) || 0 : key === "head" ? head(f) : key === "rest" ? restOf(f.id) ?? -2 : key === "type" ? f.properties.subtype || "" : f.properties.name;
  const rows = [...paddocks].sort((a, b) => {
    const x = val(a), y = val(b);
    return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true })) * dir;
  });
  const arrow = (k) => (key === k ? (dir > 0 ? " ▲" : " ▼") : "");
  return `
    <table class="list">
      <thead><tr>
        <th data-sort="name">Paddock${arrow("name")}</th>
        <th data-sort="type">Use${arrow("type")}</th>
        <th data-sort="ha" class="num">Area${arrow("ha")}</th>
        <th data-sort="head" class="num">Head${arrow("head")}</th>
        ${state.grazing.size ? `<th data-sort="rest" class="num" title="Days since last grazed">Rest${arrow("rest")}</th>` : ""}
      </tr></thead>
      <tbody>${rows.map((f) => `
        <tr class="row" data-id="${f.id}">
          <td>${escapeHtml(f.properties.name || "(unnamed)")}</td>
          <td class="muted">${escapeHtml(f.properties.subtype || "")}${f.properties.props?.crop ? ` · ${escapeHtml(f.properties.props.crop)}` : ""}</td>
          <td class="num">${ha(grazable(f))}</td>
          <td class="num">${head(f) || (state.stock.get(f.id)?.ae_per_ha ? '<span class="muted">shared</span>' : "")}</td>
          ${state.grazing.size ? `<td class="num">${restLabel(f.id)}</td>` : ""}
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function waterTable(water) {
  if (water.length === 0) return `<p class="muted">No water points yet.</p>`;
  const bySub = new Map();
  for (const f of water) {
    const k = f.properties.subtype || "other";
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push(f);
  }
  const order = ["bore", "pump", "tank", "dam", "trough", "creek", "turkey nest", "other"];
  const keys = [...bySub.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  return keys.map((k) => {
    const list = bySub.get(k).sort((a, b) => a.properties.name.localeCompare(b.properties.name, "en", { numeric: true }));
    return `
      <h3><span class="swatch" data-colour="${kindColour("water", k)}"></span>${escapeHtml(k)} · ${list.length}</h3>
      <table class="list"><tbody>${list.map((f) => {
        const pad = featureAt(state.features, pointOf(f));
        return `<tr class="row" data-id="${f.id}">
          <td>${escapeHtml(f.properties.name || "(unnamed)")}</td>
          <td class="muted">${pad ? escapeHtml(pad.properties.name) : ""}</td>
        </tr>`;
      }).join("")}</tbody></table>`;
  }).join("");
}

/** A representative point for "which paddock is this in". */
function pointOf(f) {
  const g = f.geometry;
  if (g.type === "Point") return { lng: g.coordinates[0], lat: g.coordinates[1] };
  const layer = farm.layerFor(f.id);
  const c = layer?.getBounds?.().getCenter();
  return c ? { lng: c.lng, lat: c.lat } : { lng: 0, lat: 0 };
}

function layersHtml() {
  const counts = new Map();
  for (const f of state.features) counts.set(f.properties.kind, (counts.get(f.properties.kind) || 0) + 1);
  return `
    <div class="layers">
      ${state.meta.kinds.map((k) => `
        <label>
          <input type="checkbox" data-layer="${k.id}" ${farm.isKindVisible(k.id) ? "checked" : ""}>
          <span class="swatch" data-colour="${kindColour(k.id)}"></span>
          ${escapeHtml(k.label)}
          <span class="count">${counts.get(k.id) || 0}</span>
        </label>`).join("")}
    </div>
    <p class="muted small gap-top">Imagery is chosen with the layers button at the bottom-left of the map.</p>`;
}

function toolsHtml() {
  const qld = state.meta.tileSources.find((s) => s.cache);
  return `
    ${canEdit() ? `
      <h3>Import</h3>
      <p class="muted small">Bring in paddocks and water points from an AgriWebb map export, Google Earth, or a shapefile. You review everything before it is added.</p>
      <div class="btns"><button class="btn primary" id="importBtn">Import a map file…</button></div>
    ` : ""}

    <h3>Export</h3>
    <p class="muted small">The whole map, every field included. Keep a copy somewhere safe.</p>
    <div class="btns">
      <a class="btn" href="/api/export/map.geojson" download>GeoJSON</a>
      <a class="btn" href="/api/export/map.kml" download>Google Earth (KML)</a>
    </div>

    ${qld ? `
      <h3>Offline map</h3>
      <p class="muted small">Saves ${escapeHtml(qld.label)} imagery for the whole property to this device, so the map works out of signal.</p>
      <div class="f"><label for="offZoom">Detail</label>
        <select id="offZoom">
          <option value="15">Paddock level (smallest)</option>
          <option value="16" selected>Troughs and gates visible</option>
          <option value="17">Fine detail (largest)</option>
        </select>
      </div>
      <div id="offlineStatus"></div>
      <div class="btns"><button class="btn" id="offlineBtn">Save map for offline</button></div>
    ` : ""}

    ${canEdit() ? `
      <h3>Backups</h3>
      <p class="muted small">The database copies itself every night on the server. Download a copy now and then to keep somewhere else as well.</p>
      <div id="backups"></div>
      <div class="btns"><a class="btn" href="/api/backup/download" download>Download a backup</a></div>

      <h3>Recently deleted</h3>
      <div id="deleted"><button class="btn" id="showDeleted">Show</button></div>
    ` : ""}`;
}

function bindOverview() {
  const body = $("#panelBody");
  const rainEl = $("#rainTab", body);
  if (rainEl) renderRain(rainEl, { canEdit: canEdit(), toast });
  body.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; localSet("tab", state.tab); render(); };
  });
  body.querySelectorAll("tr.row[data-id]").forEach((tr) => {
    tr.onclick = () => select(Number(tr.dataset.id), { zoom: true });
  });
  body.querySelectorAll("tr.row[data-mob]").forEach((tr) => {
    tr.onclick = () => selectMob(Number(tr.dataset.mob));
  });
  body.querySelectorAll("th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === "ha" || k === "head" || k === "rest" ? -1 : 1 };
      render();
    };
  });
  body.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.onchange = () => farm.setKindVisible(cb.dataset.layer, cb.checked);
  });
  paintSwatches(body);

  const imp = $("#importBtn", body);
  if (imp) imp.onclick = () => openImport($("#dialog"), state.meta, async (message) => {
    await loadStock();
    await loadFeatures();
    farm.fitAll();
    render();
    toast(message);
  });

  const off = $("#offlineBtn", body);
  if (off) off.onclick = () => runOffline();
  if (state.offlineRun) showOfflineProgress();

  const bk = $("#backups", body);
  if (bk) get("/api/backups").then((list) => {
    bk.innerHTML = list.length
      ? `<p class="small">Last nightly backup: ${when(list[0].at)} · ${list.length} kept</p>`
      : '<p class="muted small">No nightly backup yet.</p>';
  }).catch(() => {});
  const del = $("#showDeleted", body);
  if (del) del.onclick = () => showDeleted();
}

/** Swatch colours are set through the CSSOM, which the CSP allows, not style attributes. */
function paintSwatches(root) {
  root.querySelectorAll(".swatch[data-colour]").forEach((s) => { s.style.background = s.dataset.colour; });
}

async function showDeleted() {
  const el = $("#deleted");
  try {
    const rows = await get("/api/features/deleted");
    if (rows.length === 0) { el.innerHTML = `<p class="muted small">Nothing has been deleted.</p>`; return; }
    el.innerHTML = `<table class="list"><tbody>${rows.map((r) => `
      <tr><td>${escapeHtml(r.name || "(unnamed)")} <span class="muted">${escapeHtml(kindLabel(r.kind))}</span></td>
      <td class="muted">${when(r.deleted_at)}</td>
      <td class="num"><button class="btn" data-restore="${r.id}">Restore</button></td></tr>`).join("")}
    </tbody></table>`;
    el.querySelectorAll("[data-restore]").forEach((b) => {
      b.onclick = () => restore(Number(b.dataset.restore));
    });
  } catch (e) {
    toast(e.message, { error: true });
  }
}

async function restore(id) {
  try {
    const f = await send("POST", `/api/features/${id}/restore`);
    upsert(f);
    select(f.id, { zoom: true });
    toast(`Restored ${f.properties.name || "feature"}`);
  } catch (e) {
    toast(e.message, { error: true });
  }
}

/* offline map */

async function runOffline() {
  if (!offlineSupported()) {
    toast(location.protocol === "https:"
      ? "Offline storage is still starting up — reload the page and try again."
      : "Offline maps only work when the app is opened through its https:// address, not the local one.", { error: true });
    return;
  }
  const src = state.meta.tileSources.find((s) => s.cache);
  const all = L.featureGroup(state.features.filter((f) => f.properties.kind !== "infrastructure").map((f) => farm.layerFor(f.id)).filter(Boolean));
  if (!all.getLayers().length) { toast("Import or draw the paddocks first", { error: true }); return; }
  const bounds = all.getBounds().pad(0.05);
  const maxZ = Number($("#offZoom").value);
  const tiles = tilesFor(bounds, 10, maxZ);
  const mb = Math.round(tiles.length * 18 / 1024);
  if (!confirm(`This saves about ${tiles.length.toLocaleString()} imagery tiles (~${mb} MB) to this device. Best done on Wi-Fi. Continue?`)) return;

  const ctrl = new AbortController();
  state.offlineRun = { total: tiles.length, done: 0, failed: 0, ctrl };
  showOfflineProgress();
  const res = await downloadTiles(src.id, tiles, (done, failed) => {
    Object.assign(state.offlineRun, { done, failed });
    showOfflineProgress();
  }, ctrl.signal);
  const aborted = ctrl.signal.aborted;
  state.offlineRun = null;
  localSet("offlineSaved", String(Date.now()));
  render();
  toast(aborted ? "Stopped saving the offline map"
    : res.failed ? `Offline map saved, but ${res.failed} tiles failed — run it again to fill the gaps`
    : "Offline map saved to this device");
}

function showOfflineProgress() {
  const el = $("#offlineStatus");
  const run = state.offlineRun;
  if (!el) return;
  const btn = $("#offlineBtn");
  if (!run) {
    const saved = localGet("offlineSaved");
    el.innerHTML = saved ? `<p class="muted small">Last saved ${when(Number(saved))}.</p>` : "";
    return;
  }
  const pct = Math.round((run.done / run.total) * 100);
  el.innerHTML = `<div class="progress"><i></i></div><p class="muted small">${run.done.toLocaleString()} of ${run.total.toLocaleString()} tiles${run.failed ? ` · ${run.failed} failed` : ""}</p>`;
  el.querySelector(".progress i").style.width = `${pct}%`;
  if (btn) { btn.textContent = "Stop"; btn.onclick = () => run.ctrl.abort(); }
}

/* feature detail */

function featureBody(f) {
  const p = f.properties;
  return { kind: p.kind, name: p.name, subtype: p.subtype, props: p.props };
}

function kindFields(kind, props) {
  const v = (k) => escapeHtml(props?.[k] ?? "");
  if (kind === "paddock") return `
    <div class="row2">
      <div class="f"><label for="fCrop">Pasture / crop</label><input id="fCrop" value="${v("crop")}" placeholder="e.g. Natural grasses"></div>
      <div class="f"><label for="fGraz">Grazable ha</label><input id="fGraz" type="number" min="0" step="0.1" value="${v("grazable_ha")}" placeholder="all of it"></div>
    </div>`;
  if (kind === "water") return `
    <div class="f"><label for="fCap">Capacity (litres)</label><input id="fCap" type="number" min="0" step="100" value="${v("capacity_l")}"></div>`;
  return "";
}

function readKindFields(kind, props) {
  const out = { ...props };
  const set = (k, val) => { if (val === "" || val == null) delete out[k]; else out[k] = val; };
  if (kind === "paddock") {
    set("crop", $("#fCrop")?.value.trim());
    const g = $("#fGraz")?.value;
    set("grazable_ha", g === "" ? "" : Number(g));
  }
  if (kind === "water") {
    const c = $("#fCap")?.value;
    set("capacity_l", c === "" ? "" : Number(c));
  }
  set("notes", $("#fNotes")?.value.trim());
  return out;
}

function detailFormHtml(kind, name, subtype, props, cls) {
  const def = kindDef(kind);
  const kinds = state.meta.kinds.filter((k) => k.geoms.includes(cls));
  return `
    <div class="f"><label for="fName">Name</label><input id="fName" value="${escapeHtml(name)}" autocomplete="off"></div>
    <div class="row2">
      <div class="f"><label for="fKind">Type</label>
        <select id="fKind">${kinds.map((k) => `<option value="${k.id}"${k.id === kind ? " selected" : ""}>${escapeHtml(k.label)}</option>`).join("")}</select>
      </div>
      <div class="f"><label for="fSub">Kind of ${escapeHtml(def.label.toLowerCase())}</label>
        <input id="fSub" value="${escapeHtml(subtype || "")}" list="fSubList" autocomplete="off">
        <datalist id="fSubList">${def.subtypes.map((s) => `<option value="${escapeHtml(s)}">`).join("")}</datalist>
      </div>
    </div>
    <div id="kindFields">${kindFields(kind, props)}</div>
    <div class="f"><label for="fNotes">Notes</label><textarea id="fNotes">${escapeHtml(props?.notes || "")}</textarea></div>`;
}

function geomClassOf(g) {
  return g.type === "Point" ? "point" : g.type.includes("Line") ? "line" : "polygon";
}

function featureHtml(f) {
  const p = f.properties;
  const props = p.props || {};
  const cls = geomClassOf(f.geometry);
  const inPaddock = p.kind !== "paddock" ? featureAt(state.features, pointOf(f)) : null;

  const facts = [];
  if (p.area_ha != null) facts.push(["Mapped area", ha(p.area_ha)]);
  if (props.grazable_ha) facts.push(["Grazable", ha(Number(props.grazable_ha))]);
  if (props.agriwebb_area_ha) facts.push(["AgriWebb said", ha(Number(props.agriwebb_area_ha))]);
  if (p.length_m != null) facts.push(["Length", km(p.length_m)]);
  if (inPaddock) facts.push(["In paddock", escapeHtml(inPaddock.properties.name)]);
  if (props.capacity_l) facts.push(["Capacity", `${nf0.format(props.capacity_l)} L`]);
  if (!canEdit() && props.crop) facts.push(["Pasture", escapeHtml(props.crop)]);
  facts.push(["Last changed", when(p.updated_at)]);

  const readOnly = !canEdit()
    ? (props.notes ? `<h3>Notes</h3><p>${escapeHtml(props.notes)}</p>` : "")
    : "";

  return `
    <button class="linkbtn back" id="back">← All paddocks</button>
    <h2>${escapeHtml(p.name || "(unnamed)")}</h2>
    <p class="sub"><span class="swatch" data-colour="${kindColour(p.kind, p.subtype)}"></span>${escapeHtml(kindLabel(p.kind))}${p.subtype ? ` · ${escapeHtml(p.subtype)}` : ""}</p>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${p.kind === "paddock" ? stockHtml(f) : ""}
    ${p.kind === "paddock" ? `<h3>Grazing history</h3><div id="grazing"><p class="muted small">Loading…</p></div>` : ""}
    ${readOnly}
    ${canEdit() ? `
      <h3>Details</h3>
      ${detailFormHtml(p.kind, p.name, p.subtype, props, cls)}
      <div class="btns">
        <button class="btn primary" id="save">Save</button>
        <button class="btn" id="reshape">${cls === "point" ? "Move" : "Edit shape"}</button>
        ${p.kind === "paddock" ? `<button class="btn" id="split">Split paddock</button>` : ""}
        <button class="btn danger" id="delete">Delete</button>
      </div>` : ""}
    <h3>History</h3>
    <ul class="history" id="history"><li class="muted">Loading…</li></ul>`;
}

function bindFeature(f) {
  const body = $("#panelBody");
  paintSwatches(body);
  body.querySelectorAll("tr.row[data-mob]").forEach((tr) => {
    tr.onclick = () => selectMob(Number(tr.dataset.mob));
  });
  $("#back").onclick = () => select(null);
  if (f.properties.kind === "paddock") loadGrazing(f);
  loadHistory(f.id);
  if (!canEdit()) return;

  $("#fKind").onchange = () => {
    const k = $("#fKind").value;
    $("#kindFields").innerHTML = kindFields(k, f.properties.props);
    $("#fSubList").innerHTML = kindDef(k).subtypes.map((s) => `<option value="${escapeHtml(s)}">`).join("");
  };
  $("#save").onclick = async () => {
    const kind = $("#fKind").value;
    try {
      const saved = await send("PUT", `/api/features/${f.id}`, {
        kind,
        name: $("#fName").value,
        subtype: $("#fSub").value,
        props: readKindFields(kind, f.properties.props),
        geometry: f.geometry,
        rev: f.properties.rev,
      });
      upsert(saved);
      render();
      toast("Saved");
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  $("#reshape").onclick = () => startReshape();
  const split = $("#split");
  if (split) split.onclick = () => startSplit();
  $("#delete").onclick = async () => {
    const name = f.properties.name || kindLabel(f.properties.kind).toLowerCase();
    if (!confirm(`Delete ${name}? It can be restored from Tools → Recently deleted.`)) return;
    try {
      await send("DELETE", `/api/features/${f.id}`);
      drop(f.id);
      state.selectedId = null;
      render();
      toast(`Deleted ${name}`, { action: { label: "Undo", run: () => restore(f.id) } });
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
}

const ACTIONS = { create: "Created", update: "Edited", delete: "Deleted", restore: "Restored", split: "Split" };

async function loadHistory(id) {
  try {
    const revs = await get(`/api/features/${id}/history`);
    const el = $("#history");
    if (!el || state.selectedId !== id) return;
    el.innerHTML = revs.slice(0, 30).map((r) => `
      <li><span class="when">${when(r.ts)}</span>
      <span>${ACTIONS[r.action] || r.action}${r.username ? ` by ${escapeHtml(r.username)}` : ""}${r.area_ha != null ? ` · ${ha(r.area_ha)}` : ""}</span></li>`).join("");
  } catch {
    const el = $("#history");
    if (el) el.innerHTML = `<li class="muted">History is not available offline.</li>`;
  }
}

/* new feature */

function renderNew(def, geometry) {
  const cls = geomClassOf(geometry);
  $("#panelBody").innerHTML = `
    <h2>New ${escapeHtml(def.label.toLowerCase())}</h2>
    <p class="sub" id="newMeasure"></p>
    ${detailFormHtml(def.id, "", "", {}, cls)}
    <div class="btns">
      <button class="btn primary" id="save">Save</button>
      <button class="btn" id="discard">Discard</button>
    </div>`;
  showRoughSize(geometry);
  $("#fName").focus();
  $("#fKind").onchange = () => {
    const k = $("#fKind").value;
    $("#kindFields").innerHTML = kindFields(k, {});
    $("#fSubList").innerHTML = kindDef(k).subtypes.map((s) => `<option value="${escapeHtml(s)}">`).join("");
  };
  $("#discard").onclick = () => { editor.cancel(); endMode(); render(); };
  $("#save").onclick = async () => {
    const kind = $("#fKind").value;
    try {
      const saved = await send("POST", "/api/features", {
        kind,
        name: $("#fName").value,
        subtype: $("#fSub").value,
        props: readKindFields(kind, {}),
        geometry,
      });
      editor.finish();
      endMode();
      upsert(saved);
      select(saved.id);
      toast(`Saved ${saved.properties.name || kindLabel(kind).toLowerCase()}`);
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
}

/** A rough size for a freshly drawn shape; the server's figure replaces it on save. */
function showRoughSize(geometry) {
  const el = $("#newMeasure");
  if (!el) return;
  if (geometry.type === "Polygon") {
    const latlngs = geometry.coordinates[0].map(([x, y]) => L.latLng(y, x));
    el.textContent = `About ${ha(roughArea(latlngs) / 10_000)}`;
  } else if (geometry.type === "LineString") {
    let m = 0;
    const c = geometry.coordinates;
    for (let i = 1; i < c.length; i++) m += L.latLng(c[i - 1][1], c[i - 1][0]).distanceTo(L.latLng(c[i][1], c[i][0]));
    el.textContent = `About ${km(m)}`;
  }
}

function roughArea(latlngs) {
  // Spherical excess on the mean radius — within a fraction of a percent,
  // which is plenty for "about".
  const R = 6371008.8, rad = Math.PI / 180;
  let s = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const a = latlngs[i], b = latlngs[(i + 1) % latlngs.length];
    s += (b.lng - a.lng) * rad * (2 + Math.sin(a.lat * rad) + Math.sin(b.lat * rad));
  }
  return Math.abs((s * R * R) / 2);
}

/* split */

function renderSplitName(parent, geometry) {
  $("#panelBody").innerHTML = `
    <h2>Split ${escapeHtml(parent.properties.name || "paddock")}</h2>
    <p class="sub">The part you drew becomes a new paddock. ${escapeHtml(parent.properties.name || "The original")} keeps its name, its history and the rest of the area.</p>
    <div class="f"><label for="fName">New paddock name</label><input id="fName" autocomplete="off"></div>
    <div class="btns">
      <button class="btn primary" id="save">Split</button>
      <button class="btn" id="discard">Cancel</button>
    </div>`;
  $("#fName").focus();
  $("#discard").onclick = () => { editor.cancel(); endMode(); render(); };
  $("#save").onclick = async () => {
    try {
      const res = await send("POST", `/api/features/${parent.id}/split`, {
        geometry, name: $("#fName").value, rev: parent.properties.rev,
      });
      editor.finish();
      endMode();
      upsert(res.parent);
      upsert(res.child);
      select(res.child.id);
      toast(`Split: ${res.child.properties.name} ${ha(res.child.properties.area_ha)}, ${res.parent.properties.name} now ${ha(res.parent.properties.area_ha)}`);
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
}

/* ------------------------------- where am I -------------------------------- */

function toggleLocate() {
  const btn = $("#locateBtn");
  const on = btn.getAttribute("aria-pressed") === "true";
  if (on) {
    farm.stopLocating();
    btn.setAttribute("aria-pressed", "false");
    $("#whereAmI").hidden = true;
    return;
  }
  btn.setAttribute("aria-pressed", "true");
  const where = $("#whereAmI");
  where.hidden = false;
  where.textContent = "Finding you…";
  farm.startLocating(
    (latlng, accuracy) => {
      const p = featureAt(state.features, latlng);
      const acc = accuracy > 30 ? ` (±${Math.round(accuracy)} m)` : "";
      where.textContent = p
        ? `You're in ${p.properties.name} · ${ha(grazable(p))}${acc}`
        : `Not inside a mapped paddock${acc}`;
    },
    (msg) => {
      where.textContent = `Location unavailable: ${msg}`;
      btn.setAttribute("aria-pressed", "false");
      farm.stopLocating();
    }
  );
}

/* ---------------------------------- start ---------------------------------- */

async function start() {
  try {
    state.meta = await get("/api/meta");
  } catch (e) {
    $("#panelBody").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    return;
  }
  const m = state.meta;
  document.title = `${m.propertyName} · Grazing`;
  $("#propName").textContent = m.propertyName;
  $("#whoName").textContent = m.user ? `${m.user.username}${m.user.role === "viewer" ? " (view only)" : ""}` : "";
  $("#tools").hidden = !m.canEdit;

  farm = new FarmMap($("#map"), m, {
    onSelect: (id) => select(id),
    onMapClick: () => { if (state.selectedId !== null) select(null); },
    isBusy: () => state.mode !== null,
  });
  editor = new Editor(farm.map);

  farm.labelExtra = (f) => {
    const s = state.stock.get(f.id);
    return s && s.head ? ` · ${s.head} hd` : "";
  };
  await loadStock();
  try {
    await loadFeatures();
  } catch (e) {
    toast(e.message, { error: true });
  }
  if (!farm.fitAll()) farm.map.setView(m.mapCentre, m.mapZoom);
  render();

  // Toolbar
  $("#tools").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-draw]");
    if (!b) return;
    if (b.dataset.draw === "more") { showMoreKinds(); return; }
    startDraw(b.dataset.draw);
  });
  $("#modeCancel").onclick = cancelMode;
  $("#modeDone").onclick = () => { if (state.mode === "reshape") saveReshape(); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.mode && !$("#dialog").open) cancelMode();
  });

  $("#search").addEventListener("change", onSearch);
  $("#search").addEventListener("keydown", (e) => { if (e.key === "Enter") onSearch(); });
  $("#fitBtn").onclick = () => farm.fitAll();
  $("#locateBtn").onclick = toggleLocate;
  $("#grip").onclick = () => openSheet(!document.querySelector(".app").classList.contains("sheet-open"));
  $("#signOut").onclick = async () => {
    try { await send("POST", "/api/auth/logout"); } finally { location.href = "/"; }
  };

  const net = () => { $("#netStatus").hidden = navigator.onLine; };
  window.addEventListener("online", () => { net(); loadFeatures().then(render).catch(() => {}); });
  window.addEventListener("offline", net);
  net();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline is a bonus, not a requirement */ });
  }
}

function showMoreKinds() {
  if (state.mode) cancelMode();
  select(null);
  const common = new Set(["paddock", "fence", "water", "infrastructure"]);
  $("#panelBody").innerHTML = `
    <button class="linkbtn back" id="back">← Back</button>
    <h2>Draw something else</h2>
    <div class="btns">${state.meta.kinds.filter((k) => !common.has(k.id)).map((k) =>
      `<button class="btn" data-kind="${k.id}"><span class="swatch" data-colour="${kindColour(k.id)}"></span>${escapeHtml(k.label)}</button>`
    ).join("")}</div>`;
  paintSwatches($("#panelBody"));
  $("#back").onclick = () => render();
  $("#panelBody").querySelectorAll("[data-kind]").forEach((b) => {
    b.onclick = () => startDraw(b.dataset.kind);
  });
  openSheet(true);
}

start();

/* ---------------------------------- mobs ----------------------------------- */

function mobsTable() {
  if (state.mobs.length === 0) {
    return `<p class="muted small">No mobs yet. ${canEdit() ? "Import AgriWebb's mob list (.xlsx) from <b>Tools</b>." : ""}</p>`;
  }
  const mobs = [...state.mobs].sort((a, b) => b.head - a.head);
  const total = (ms) => ms.reduce((s, m) => s + (m.ae_total || 0), 0);
  const rows = (ms) => ms.map((m) => `
    <tr class="row" data-mob="${m.id}">
      <td>${escapeHtml(m.name)}<div class="muted tiny">${escapeHtml(m.paddocks.map((p) => p.name).join(", ") || "not in a paddock")}</div></td>
      <td class="num">${m.head}</td>
      <td class="num">${kg(m.est_weight_kg)}</td>
      <td class="num">${m.ae_total != null ? nf0.format(m.ae_total) : "—"}</td>
    </tr>`).join("");
  const own = mobs.filter((m) => !m.owner);
  const agisted = mobs.filter((m) => m.owner);
  const head = `<thead><tr><th>Mob</th><th class="num">Head</th><th class="num">Weight</th><th class="num">AE</th></tr></thead>`;
  return `
    <h3>Own stock · ${nf0.format(ownHead(own))} head · ${nf0.format(total(own))} AE</h3>
    <table class="list">${head}<tbody>${rows(own)}</tbody></table>
    ${agisted.length ? `
      <h3>Agistment · ${nf0.format(agistHead(agisted))} head · ${nf0.format(total(agisted))} AE</h3>
      <table class="list">${head}<tbody>${rows(agisted)}</tbody></table>` : ""}
    <p class="muted small gap-top">AE is worked from each mob's weight (a 450 kg steer = 1 AE).</p>`;
}

function stockHtml(f) {
  const s = state.stock.get(f.id);
  const here = state.mobs.filter((m) => m.paddock_ids.includes(f.id));
  if (!s || here.length === 0) return `<h3>Stock</h3><p class="muted small">No stock recorded here.</p>`;
  const shared = [...new Set(here.flatMap((m) => m.paddocks.filter((p) => p.id !== f.id).map((p) => p.name)))];
  return `
    <h3>Stock</h3>
    <dl class="facts">
      <dt>Stocking rate</dt><dd>${s.ae_per_ha.toFixed(2)} AE/ha</dd>
      ${shared.length ? `<dt>Gates open to</dt><dd>${escapeHtml(shared.join(", "))}</dd>` : ""}
    </dl>
    <table class="list"><tbody>${here.map((m) => `
      <tr class="row" data-mob="${m.id}">
        <td>${escapeHtml(m.name)}${m.owner ? ` <span class="chip owner">${escapeHtml(m.owner)}</span>` : ""}</td>
        <td class="num">${m.head} hd</td>
        <td class="num">${kg(m.est_weight_kg)}</td>
      </tr>`).join("")}</tbody></table>
    ${shared.length ? `<p class="muted small">Stocking rate spreads each mob over every paddock it can reach.</p>` : ""}`;
}

function mobHtml(m) {
  const facts = [
    ["Head", String(m.head)],
    ["Where", m.paddocks.map((p) => `<button class="linkbtn" data-paddock="${p.id}">${escapeHtml(p.name)}</button>`).join(", ") || "—"],
    ["Owner", m.owner ? escapeHtml(m.owner) : "Own stock"],
    ["Breed", escapeHtml(m.breed || "—")],
    ["Class", escapeHtml([m.age_class, m.sex].filter(Boolean).join(" · ") || "—")],
    ["Born", escapeHtml(m.birth_date || "—")],
    ["Origin", escapeHtml(m.origin || "—")],
    ["Tag colour", escapeHtml(m.tag_colour || "—")],
    ["Last weighed", m.last_weighed ? `${kg(m.weight_kg)} on ${escapeHtml(m.last_weighed)}` : "—"],
    ["Daily gain", m.adg_kg ? `${m.adg_kg} kg/day (assumed)` : "none set"],
    ["Weight today", kg(m.est_weight_kg)],
    ["AE per head", m.ae_head != null ? m.ae_head.toFixed(2) : "—"],
    ["AE total", m.ae_total != null ? nf1.format(m.ae_total) : "—"],
  ];
  if (m.agriwebb_ae_head != null) facts.push(["AgriWebb AE/head", m.agriwebb_ae_head.toFixed(2)]);
  return `
    <button class="linkbtn back" id="back">← All mobs</button>
    <h2>${escapeHtml(m.name)}</h2>
    <p class="sub">${escapeHtml(m.species)}${m.owner ? ` · agistment, ${escapeHtml(m.owner)}` : ""}</p>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${canEdit() ? `
      <h3>Details</h3>
      <div class="f"><label for="mName">Name</label><input id="mName" value="${escapeHtml(m.name)}" autocomplete="off"></div>
      <div class="row2">
        <div class="f"><label for="mOwner">Owner</label>
          <input id="mOwner" value="${escapeHtml(m.owner || "")}" placeholder="own stock" list="mOwners" autocomplete="off">
          <datalist id="mOwners">${[...new Set(state.mobs.map((x) => x.owner).filter(Boolean))].map((o) => `<option value="${escapeHtml(o)}">`).join("")}</datalist>
          <div class="hint">Blank for your own cattle; the owner's name for agistment.</div>
        </div>
        <div class="f"><label for="mSex">Sex</label>
          <select id="mSex">${["", "female", "steer", "male"].map((v) => `<option value="${v}"${v === (m.sex || "") ? " selected" : ""}>${v || "mixed / unknown"}</option>`).join("")}</select>
        </div>
      </div>
      <div class="f"><label for="mDesc">Description</label><textarea id="mDesc">${escapeHtml(m.description || "")}</textarea></div>
      <div class="btns"><button class="btn primary" id="mSave">Save</button></div>
      ${moveFormHtml(m)}`
    : m.description ? `<h3>Description</h3><p>${escapeHtml(m.description)}</p>` : ""}
    <h3>History</h3>
    <ul class="history" id="mobEvents"><li class="muted">Loading…</li></ul>
    <p class="muted small gap-top">Weighing, counting and splitting mobs come next.</p>`;
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Moving a mob and opening gates are one action: tick every paddock it can
 * reach from that date. Ticked paddocks sort to the top so the current
 * position is always visible without scrolling through all of them.
 */
function moveFormHtml(m) {
  const paddocks = state.features
    .filter((f) => f.properties.kind === "paddock")
    .sort((a, b) => {
      const ai = m.paddock_ids.includes(a.id) ? 0 : 1, bi = m.paddock_ids.includes(b.id) ? 0 : 1;
      return ai - bi || a.properties.name.localeCompare(b.properties.name, "en", { numeric: true });
    });
  const others = (id) => {
    const h = state.mobs.filter((x) => x.id !== m.id && x.paddock_ids.includes(id)).reduce((t, x) => t + x.head, 0);
    return h ? ` <span class="muted">· ${h} hd other stock</span>` : "";
  };
  return `
    <h3>Move or open gates</h3>
    <div class="row2">
      <div class="f"><label for="mvDate">From</label><input id="mvDate" type="date" value="${localToday()}" max="${localToday()}"></div>
      <div class="f"><label for="mvFilter">Find paddock</label><input id="mvFilter" type="search" placeholder="Filter…" autocomplete="off"></div>
    </div>
    <div class="checklist" id="mvList">${paddocks.map((f) => `
      <label data-name="${escapeHtml(f.properties.name.toLowerCase())}">
        <input type="checkbox" value="${f.id}"${m.paddock_ids.includes(f.id) ? " checked" : ""}>
        ${escapeHtml(f.properties.name)} <span class="muted">${ha(grazable(f))}</span>${others(f.id)}
      </label>`).join("")}
    </div>
    <p class="muted small" id="mvSummary"></p>
    <div class="f"><label for="mvNote">Note</label><input id="mvNote" placeholder="optional" autocomplete="off"></div>
    <div class="btns"><button class="btn primary" id="mvSave">Record move</button></div>`;
}

function bindMob(m) {
  loadMobEvents(m.id);
  const list = $("#mvList");
  if (list) {
    // Order matters: the first paddock is where the head is counted, so the
    // current one keeps that place and new ones follow in the order ticked.
    const chosen = [...m.paddock_ids];
    const areaOf = (id) => { const f = state.byId.get(id); return f ? grazable(f) || 0 : 0; };
    const summary = () => {
      const area = chosen.reduce((t, id) => t + areaOf(id), 0);
      $("#mvSummary").textContent = chosen.length
        ? `${chosen.length} paddock${chosen.length === 1 ? "" : "s"}, ${ha(area)}${m.ae_total && area ? ` → ${(m.ae_total / area).toFixed(2)} AE/ha for this mob` : ""}`
        : "Tick at least one paddock.";
    };
    list.addEventListener("change", (e) => {
      const id = Number(e.target.value);
      const i = chosen.indexOf(id);
      if (e.target.checked && i < 0) chosen.push(id);
      if (!e.target.checked && i >= 0) chosen.splice(i, 1);
      summary();
    });
    $("#mvFilter").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      list.querySelectorAll("label").forEach((l) => {
        l.hidden = q !== "" && !l.dataset.name.includes(q) && !l.querySelector("input").checked;
      });
    });
    $("#mvSave").onclick = async () => {
      try {
        await send("POST", `/api/mobs/${m.id}/move`, {
          date: $("#mvDate").value, paddock_ids: chosen, note: $("#mvNote").value,
        });
        await loadStock();
        farm.setFeatures(state.features); // relabel head counts
        render();
        toast("Move recorded");
      } catch (e) {
        toast(e.message, { error: true });
      }
    };
    summary();
  }
  const save = $("#mSave");
  if (save) save.onclick = async () => {
    try {
      await send("PATCH", `/api/mobs/${m.id}`, {
        name: $("#mName").value, owner: $("#mOwner").value, sex: $("#mSex").value, description: $("#mDesc").value,
      });
      await loadStock();
      render();
      toast("Saved");
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  $("#back").onclick = () => {
    state.selectedMobId = null;
    state.tab = "mobs";
    render();
  };
  $("#panelBody").querySelectorAll("[data-paddock]").forEach((el) => {
    el.onclick = () => select(Number(el.dataset.paddock), { zoom: true });
  });
}

/* ----------------------------- grazing history ----------------------------- */

/** "12 Nov – 11 Dec 2025", "10 Dec 2025 – 4 Feb 2026", "24 Sept 2026 – now". */
function span(from, to) {
  const fy = from.slice(0, 4), ty = to ? to.slice(0, 4) : null;
  if (!to) return `${shortDay(from)} ${fy} – now`;
  return fy === ty ? `${shortDay(from)} – ${shortDay(to)} ${ty}` : `${shortDay(from)} ${fy} – ${shortDay(to)} ${ty}`;
}

async function loadGrazing(f) {
  let data;
  try {
    data = await get(`/api/paddocks/${f.id}/grazing`);
  } catch {
    const el = $("#grazing");
    if (el) el.innerHTML = '<p class="muted small">Not available offline.</p>';
    return;
  }
  const el = $("#grazing");
  if (!el || state.selectedId !== f.id) return;
  const h = data.history;
  if (!h) {
    el.innerHTML = data.records_begin
      ? `<p class="muted small">Not grazed since records began on ${day(data.records_begin)}.</p>`
      : '<p class="muted small">No stock records yet.</p>';
    return;
  }
  const area = grazable(f) || 0;
  const status = h.occupied
    ? '<span class="inuse">In use now</span>'
    : `Resting <b>${h.rest_days} days</b>, since ${day(h.last_grazed)}`;

  // Newest first, grazing periods and rests interleaved.
  const items = [
    ...h.periods.map((p) => ({ at: p.from, p })),
    ...h.rests.map((r) => ({ at: r.from, r })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.p ? -1 : 1));

  el.innerHTML = `
    <p class="small">${status}</p>
    <dl class="facts">
      <dt>Last 12 months</dt><dd>${h.grazing_days_365} grazing days · ${nf0.format(h.head_days_365)} head-days${area ? ` (${nf0.format(h.head_days_365 / area)} per ha)` : ""}</dd>
    </dl>
    <ul class="timeline">${items.map(({ p, r }) => p ? `
      <li class="graze">
        <div class="when">${span(p.from, p.to)}<span class="muted"> · ${p.days} d</span></div>
        <div><button class="linkbtn" data-mob="${p.mob_id}">${escapeHtml(p.mob_name)}</button>${p.owner ? ` <span class="chip owner">${escapeHtml(p.owner)}</span>` : ""}</div>
        <div class="muted tiny">${p.head_start === p.head_end ? `${p.head_start} hd` : `${p.head_start} → ${p.head_end} hd`} · ${nf0.format(p.head_days)} head-days${p.shared_with.length ? ` · gates open to ${escapeHtml(p.shared_with.join(", "))}` : ""}</div>
      </li>` : `
      <li class="rest"><span class="muted">${r.from === data.records_begin && r.to
        ? `No stock recorded from the start of records (${r.days} d)`
        : `Rested ${r.days} d${r.to ? "" : " so far"}`}</span></li>`).join("")}
    </ul>
    <p class="muted tiny">Records begin ${day(data.records_begin)}. Head-days use the head count, not weight: AgriWebb's movement report has no weights.</p>`;
  el.querySelectorAll("[data-mob]").forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.mob);
      if (mobById(id)) selectMob(id);
      else toast("That mob has since been sold or merged; its record is kept but is not in the current list.");
    };
  });
}

const EVENT_TEXT = {
  opening: (e) => e.agriwebb_event === "Created from draft/split" ? `Drafted off${e.from_mob ? ` from ${e.from_mob}` : ""} · ${e.head} hd`
    : e.agriwebb_event === "Purchased" ? `Purchased · ${e.head} hd`
    : e.source.startsWith("import:") ? `AgriWebb mob list: ${e.head} hd`
    : `Started · ${e.head} hd`,
  move: () => "Moved",
  transfer: (e) => e.off_farm ? `Transferred off farm · ${Math.abs(e.head_change)} hd`
    : e.head_change < 0 ? `Drafted ${-e.head_change} hd${e.to_mob ? ` to ${e.to_mob}` : ""}${e.to_paddock ? ` (${e.to_paddock})` : ""}`
    : `Merged in ${e.head_change} hd${e.from_mob ? ` from ${e.from_mob}` : ""}`,
  sale: (e) => `Sold ${-e.head_change} hd`,
  death: (e) => `${-e.head_change} died`,
  purchase: (e) => `Bought ${e.head_change} hd`,
  count: (e) => `Recounted: ${e.head} hd`,
  weigh: (e) => e.weight_kg ? `Weighed · ${nf0.format(e.weight_kg)} kg` : "Weighed (weight not recorded)",
};

async function loadMobEvents(id) {
  const el = $("#mobEvents");
  try {
    const all = await get(`/api/mobs/${id}/events`);
    if (!el || state.selectedMobId !== id) return;
    // AgriWebb's history notes a weighing without its weight; when the mob list
    // supplies the weight for the same day, show that one only.
    const weighed = new Set(all.filter((e) => e.kind === "weigh" && e.weight_kg).map((e) => e.date));
    const events = all.filter((e) => !(e.kind === "weigh" && !e.weight_kg && weighed.has(e.date)));
    el.innerHTML = events.map((e) => `
      <li><span class="when">${day(e.date)}</span>
      <span>${escapeHtml((EVENT_TEXT[e.kind] || (() => e.kind))(e))}${e.paddocks ? ` → ${escapeHtml(e.paddocks.join(", "))}` : ""}</span></li>`).join("")
      || '<li class="muted">Nothing recorded.</li>';
  } catch {
    if (el) el.innerHTML = '<li class="muted">History is not available offline.</li>';
  }
}
