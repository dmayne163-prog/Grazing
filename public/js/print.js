/**
 * The print map, for handing to a contractor: the property on a sheet of A4
 * or A3, with which paddocks are open into each other, every gate (open in
 * green, shut in grey), water points, which mob is where today, and the job
 * marked on it — click paddocks to mark them "move from", "move to" or "job
 * here". Title, notes, date, north arrow, scale and a legend print with it.
 *
 * Its own page (print.html), opened in a new tab from the app, so the app's
 * panels and buttons never end up on paper.
 */
import { get } from "./api.js";
import { escapeHtml, interiorPoint, kindColour, localGet, localSet, outsideEdges } from "./map.js";

const $ = (s) => document.querySelector(s);
const OPEN = "#1e9e5a";
const JOB = {
  from: { label: "Move from", colour: "#e07a1f" },
  to: { label: "Move to", colour: "#2069c9" },
  here: { label: "Job here", colour: "#b3261e" },
};
const CYCLE = [null, "from", "to", "here"];
const PAPER = { A4: [297, 210], A3: [420, 297] };
const isGate = (f) => (f.properties.subtype || "").toLowerCase() === "gate";

const today = new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

let meta, features, mobs, gates, map, base, layers = [];
const job = new Map(JSON.parse(localGet("printJob") || "[]")); // paddock id → from | to | here

async function start() {
  try {
    [meta, { features }, mobs, gates] = await Promise.all([get("/api/meta"), get("/api/features"), get("/api/mobs"), get("/api/gates")]);
  } catch (e) {
    $("#status").textContent = `Couldn't load the map: ${e.message}. Sign in to the app first.`;
    return;
  }
  $("#title").value = localGet("printTitle") || `${meta.propertyName}`;
  $("#notes").value = localGet("printNotes") || "";
  $("#paper").value = localGet("printPaper") || "A4";
  $("#orient").value = localGet("printOrient") || "landscape";
  const bases = meta.tileSources.filter((s) => !s.overlay);
  $("#base").innerHTML = `<option value="">Plain (no imagery, saves ink)</option>${bases.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join("")}`;
  $("#base").value = localGet("printBase") ?? bases[0]?.id ?? "";
  for (const id of ["showOpen", "showGates", "showMobs", "showWater", "showHa", "showTracks"]) {
    const v = localGet(`print_${id}`);
    if (v !== null) $(`#${id}`).checked = v === "1";
  }

  map = L.map("map", { zoomControl: true, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: true });
  map.setView(meta.mapCentre, meta.mapZoom); // a start, until it can frame the property
  map.attributionControl.setPrefix(false);
  L.control.scale({ metric: true, imperial: false, maxWidth: 160, position: "bottomleft" }).addTo(map);
  sizeSheet();
  draw();
  // The map measures itself once the sheet is laid out at paper size, and again
  // whenever that size changes; it frames the property once it knows its size.
  let framed = false;
  new ResizeObserver(() => {
    map.invalidateSize();
    if (!framed && $("#map").clientHeight > 50) { framed = true; fitAll(); }
  }).observe($("#map"));

  const save = (k, v) => localSet(k, v);
  $("#title").oninput = () => { save("printTitle", $("#title").value); texts(); };
  $("#notes").oninput = () => { save("printNotes", $("#notes").value); texts(); };
  $("#paper").onchange = $("#orient").onchange = () => { save("printPaper", $("#paper").value); save("printOrient", $("#orient").value); sizeSheet(); };
  $("#base").onchange = () => { save("printBase", $("#base").value); draw(); };
  for (const id of ["showOpen", "showGates", "showMobs", "showWater", "showHa", "showTracks"]) {
    $(`#${id}`).onchange = () => { save(`print_${id}`, $(`#${id}`).checked ? "1" : "0"); draw(); };
  }
  $("#fitAll").onclick = fitAll;
  $("#fitJob").onclick = () => {
    const ids = [...job.keys()];
    if (!ids.length) { $("#status").textContent = "Click some paddocks first to mark the job."; return; }
    const b = L.latLngBounds([]);
    for (const f of features) if (ids.includes(f.id)) b.extend(L.geoJSON(f).getBounds());
    map.fitBounds(b, { padding: [30, 30] });
  };
  $("#print").onclick = () => window.print();
  texts();
}

/** The sheet's size in millimetres for the paper, and the matching @page rule. */
function sizeSheet() {
  let [w, h] = PAPER[$("#paper").value];
  if ($("#orient").value === "portrait") [w, h] = [h, w];
  const margin = 8;
  const sheet = $("#sheet");
  sheet.style.width = `${w - margin * 2}mm`;
  sheet.style.height = `${h - margin * 2}mm`;
  // CSSOM, not an inline <style>: the page's content security policy allows it.
  const css = [...document.styleSheets].find((s) => (s.href || "").endsWith("/print.css"));
  if (css) {
    for (let i = css.cssRules.length - 1; i >= 0; i--) if (css.cssRules[i].type === CSSRule.PAGE_RULE) css.deleteRule(i);
    css.insertRule(`@page { size: ${$("#paper").value} ${$("#orient").value}; margin: ${margin}mm; }`, css.cssRules.length);
  }
}

function fitAll() {
  const ps = features.filter((f) => f.properties.kind === "paddock" || f.properties.kind === "boundary");
  if (ps.length) map.fitBounds(L.geoJSON({ type: "FeatureCollection", features: ps }).getBounds(), { padding: [20, 20] });
  else map.setView(meta.mapCentre, meta.mapZoom);
}

function texts() {
  $("#titleOut").textContent = $("#title").value || meta.propertyName;
  $("#sub").textContent = `${meta.propertyName} · printed ${today}`;
  $("#notesOut").textContent = $("#notes").value.trim();
}

/** Which paddocks are open into which: by open gates, and by mobs that reach several paddocks. */
function openGroups() {
  const parent = new Map();
  const root = (x) => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x); return x; };
  const join = (a, b) => { const ra = root(a), rb = root(b); if (ra !== rb) parent.set(ra, rb); };
  for (const g of gates) if (g.state === "open" && g.paddocks.length === 2) join(g.paddocks[0], g.paddocks[1]);
  for (const m of mobs) for (let i = 1; i < m.paddock_ids.length; i++) join(m.paddock_ids[0], m.paddock_ids[i]);
  const members = new Map();
  for (const id of new Set([...parent.keys(), ...parent.values()])) {
    const r = root(id);
    members.set(r, [...(members.get(r) ?? []), id]);
  }
  const out = new Map();
  for (const list of members.values()) if (list.length > 1) for (const id of list) out.set(id, list.filter((x) => x !== id));
  return out;
}

function draw() {
  for (const l of layers) l.remove();
  layers = [];
  const add = (l) => { l.addTo(map); layers.push(l); return l; };
  const imagery = $("#base").value;
  $("#map").classList.toggle("imagery", !!imagery);
  if (imagery) {
    const src = meta.tileSources.find((s) => s.id === imagery);
    add(L.tileLayer(`/tiles/${src.id}/{z}/{x}/{y}`, { maxNativeZoom: src.maxZoom, maxZoom: 21, attribution: src.attribution }));
  }
  const line = imagery ? "#ffffff" : "#222222";
  const open = $("#showOpen").checked ? openGroups() : new Map();
  const byId = new Map(features.map((f) => [f.id, f]));
  const mobsIn = new Map();
  if ($("#showMobs").checked) {
    for (const m of mobs) {
      if (!m.head) continue;
      // One label per mob, in the first of its paddocks.
      const id = m.paddock_ids[0];
      // The name up to its first " · " (AgriWebb added the paddock or year after one).
      if (id) mobsIn.set(id, [...(mobsIn.get(id) ?? []), { name: m.name.split(" · ")[0], head: m.head }]);
    }
  }

  for (const f of features) {
    const k = f.properties.kind;
    if (k === "boundary") add(L.geoJSON(f, { style: { color: line, weight: 3, dashArray: "10 6", fill: false }, interactive: false }));
    if (k === "track" && $("#showTracks").checked) add(L.geoJSON(f, { style: { color: imagery ? "#ffe08a" : "#8a6d3b", weight: 2, dashArray: "3 5" }, interactive: false }));
    if (k === "water" && f.geometry.type !== "Point" && $("#showWater").checked) add(L.geoJSON(f, { style: { color: "#1b6fb3", weight: 1, fillColor: "#5aa9e6", fillOpacity: 0.6 }, interactive: false }));
  }

  // Paddocks: fill by job mark, tint if open into another, label with name, mob and mark.
  for (const f of features.filter((x) => x.properties.kind === "paddock")) {
    const mark = job.get(f.id);
    const style = {
      color: line, weight: 1.4, opacity: 0.9,
      fillColor: mark ? JOB[mark].colour : open.has(f.id) ? OPEN : kindColour("paddock", f.properties.subtype),
      fillOpacity: mark ? 0.38 : open.has(f.id) ? 0.18 : imagery ? 0.02 : 0.05,
    };
    const layer = add(L.geoJSON(f, { style }));
    layer.on("click", () => {
      const next = CYCLE[(CYCLE.indexOf(job.get(f.id) ?? null) + 1) % CYCLE.length];
      if (next) job.set(f.id, next); else job.delete(f.id);
      localSet("printJob", JSON.stringify([...job]));
      draw();
    });
    const pt = interiorPoint(f.geometry);
    if (pt && f.properties.name) {
      const ha = $("#showHa").checked && f.properties.area_ha ? ` <span class="ha">${Math.round(f.properties.area_ha)} ha</span>` : "";
      // Two mobs at most by name; more than that as one line, so labels don't pile up.
      const here = mobsIn.get(f.id) ?? [];
      const mobLines = (here.length > 2
        ? [`${here.length} mobs · ${here.reduce((t, m) => t + m.head, 0)} hd`]
        : here.map((m) => `${m.name} · ${m.head} hd`)).map((t) => `<span class="mob">${escapeHtml(t)}</span>`).join("");
      const jobLine = mark ? `<span class="job" data-c="${mark}">${escapeHtml(JOB[mark].label.toUpperCase())}</span>` : "";
      const tip = add(L.tooltip({ permanent: true, direction: "center", className: "plab", interactive: false })
        .setLatLng(pt).setContent(`${escapeHtml(f.properties.name)}${ha}${jobLine}${mobLines}`));
      // The job line in its own colour (CSSOM: no inline styles under the CSP).
      tip.on("add", () => colourJob(tip));
      colourJob(tip);
    }
  }

  // The outside fence of each open group, drawn bold so it reads as one area.
  if (open.size) {
    const lines = [];
    for (const [id, others] of open) {
      const g = byId.get(id)?.geometry;
      if (g) lines.push(...outsideEdges(g, others.map((o) => byId.get(o)?.geometry).filter(Boolean)));
    }
    add(L.polyline(lines, { color: OPEN, weight: 4, opacity: 1, interactive: false, lineCap: "round" }));
  }

  // Points: gates by state, water points.
  const gateState = new Map(gates.map((g) => [g.gate_id, g.state]));
  for (const f of features.filter((x) => x.geometry.type === "Point")) {
    const [lon, lat] = f.geometry.coordinates;
    if (isGate(f) && $("#showGates").checked) {
      const isOpen = gateState.get(f.id) === "open";
      add(L.circleMarker([lat, lon], { radius: isOpen ? 6 : 4, color: "#111", weight: 1.5, fillColor: isOpen ? OPEN : "#9aa0a3", fillOpacity: 1, interactive: false }));
    } else if (f.properties.kind === "water" && $("#showWater").checked) {
      add(L.circleMarker([lat, lon], { radius: 4.5, color: "#fff", weight: 1.5, fillColor: "#1b6fb3", fillOpacity: 1, interactive: false }));
    }
  }
  legend(open.size > 0);
}

function colourJob(tip) {
  const el = tip.getElement?.();
  const j = el?.querySelector(".job");
  if (j) j.style.color = JOB[j.dataset.c].colour;
}

function legend(anyOpen) {
  const items = [];
  const marks = new Set(job.values());
  for (const [k, v] of Object.entries(JOB)) if (marks.has(k)) items.push([v.colour, v.label, "box", true]);
  if ($("#showOpen").checked && anyOpen) items.push([OPEN, "Paddocks open into each other (green outline)", "box", false]);
  if ($("#showGates").checked) { items.push([OPEN, "Gate open", "dot", true]); items.push(["#9aa0a3", "Gate shut", "dot", true]); }
  if ($("#showWater").checked) items.push(["#1b6fb3", "Water", "dot", true]);
  if ($("#showTracks").checked) items.push(["#8a6d3b", "Track", "line", false]);
  const el = $("#legend");
  el.innerHTML = items.map((_, i) => `<span><i data-i="${i}"></i>${escapeHtml(items[i][1])}</span>`).join("")
    + (mobs.some((m) => m.head) && $("#showMobs").checked ? '<span class="muted">Mob names: as recorded today</span>' : "");
  el.querySelectorAll("i").forEach((i) => {
    const [colour, , shape, filled] = items[Number(i.dataset.i)];
    if (shape === "dot") i.classList.add("dot");
    i.style.borderColor = shape === "dot" ? "#111" : colour;
    i.style.background = filled ? colour : "transparent";
    if (shape === "line") { i.style.height = "0"; i.style.borderWidth = "0 0 3px 0"; i.style.borderStyle = "dashed"; }
  });
}

start();
