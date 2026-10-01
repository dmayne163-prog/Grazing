/**
 * The Pasture tab: Cibo Labs' monthly pasture biomass for the farm, against
 * Cibo's reference area around it, with a table view and the importer.
 *
 * Whole-farm figures for now. Paddock-by-paddock readings come with a
 * PastureKey download, and the pasture model builds on both.
 */
import { get } from "./api.js";
import { escapeHtml } from "./map.js";

// Validated on the dark surface (#151A1D) beside the SILO orange: lightness
// band, chroma, colour-blind separation and 3:1 contrast all pass.
const PASTURE = "#199e70";
const REF = "#A3B1B7"; // the district reference: a neutral, not a series hue
const GRID = "#1F282C", AXIS = "#3A464C", TICK_TEXT = "#75848B", INK = "#E7EEF0";
const SVGNS = "http://www.w3.org/2000/svg";

const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const fmtMonth = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { month: "short", year: "numeric" });
const kg = (v) => (v === null || v === undefined ? "—" : `${Math.round(v).toLocaleString("en-AU")} kg/ha`);

export async function renderPasture(el, ctx) {
  let data;
  try {
    data = await get("/api/pasture");
  } catch (e) {
    el.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
    return;
  }
  const importBtn = ctx.canEdit
    ? '<div class="btns gap-top"><button class="btn" data-import="pasture">Import a Cibo Labs pasture report…</button></div>'
    : "";
  const bind = () => el.querySelectorAll("[data-import]").forEach((b) => { b.onclick = () => ctx.startImport(b.dataset.import); });

  const farm = data.farm;
  if (!farm.length) {
    el.innerHTML = `<p class="muted small">No pasture readings yet. Cibo Labs' Pasture Biomass report (the .zip they email) brings in the farm's monthly pasture back to 2017.</p>${importBtn}`;
    bind();
    return;
  }

  const last = farm[farm.length - 1];
  const prev = farm.length > 1 ? farm[farm.length - 2] : null;
  const yearAgo = farm.slice().reverse().find((r) => r.date <= shiftYear(last.date, -1));
  const sameMonth = farm.filter((r) => r.date.slice(5, 7) === last.date.slice(5, 7) && r.date !== last.date && r.p50 !== null);
  const typical = sameMonth.length ? median(sameMonth.map((r) => r.p50)) : null;
  const cov = data.coverage;
  const outside = cov ? cov.short.filter((s) => s.share < 0.5) : [];
  const change = (a, before) => (a === null || !before || before.p50 === null ? "" : ` <span class="muted">(${a >= before.p50 ? "+" : "−"}${Math.abs(Math.round(a - before.p50)).toLocaleString("en-AU")} since ${fmtMonth(before.date)})</span>`);

  el.innerHTML = `
    <dl class="facts">
      <dt>Latest</dt><dd><b>${kg(last.p50)}</b> farm median, ${fmtDay(last.date)}${change(last.p50, prev)}</dd>
      <dt>Middle half</dt><dd>${kg(last.p25)} to ${kg(last.p75)} <span class="muted">across the farm</span></dd>
      <dt>District</dt><dd>${kg(last.ref_p50)} <span class="muted">median in Cibo's reference area</span></dd>
      ${typical !== null ? `<dt>Usual for ${new Date(`${last.date}T00:00:00`).toLocaleDateString("en-AU", { month: "long" })}</dt><dd>${kg(typical)} <span class="muted">(median of ${sameMonth.length} years)</span></dd>` : ""}
      ${yearAgo ? `<dt>A year ago</dt><dd>${kg(yearAgo.p50)} <span class="muted">${fmtDay(yearAgo.date)}</span></dd>` : ""}
    </dl>
    <h3>Pasture on the farm · Cibo Labs</h3>
    <div class="legend">
      <span><i class="sw sw-pasture"></i>Farm median</span>
      <span><i class="sw sw-pasture-band"></i>Middle half of the farm</span>
      <span><i class="sw sw-ref"></i>District median</span>
    </div>
    <div class="rainchart" id="pastureChart"></div>
    <p class="muted tiny">Total standing dry matter: all the grass standing, green and dead, in kg of dry matter a hectare, estimated from satellite images. One reading a month.</p>
    <details class="gap-top"><summary class="small">Readings as a table</summary>
      <table class="list"><thead><tr><th>Date</th><th class="num">Median</th><th class="num">Middle half</th><th class="num">District</th><th class="num">Growth</th></tr></thead><tbody>
        ${[...farm].reverse().map((r) => `<tr><td>${fmtDay(r.date)}</td><td class="num">${kg(r.p50)}</td>
          <td class="num muted">${r.p25 === null ? "—" : `${Math.round(r.p25).toLocaleString("en-AU")}–${Math.round(r.p75).toLocaleString("en-AU")}`}</td>
          <td class="num">${kg(r.ref_p50)}</td><td class="num muted">${r.growth === null ? "—" : kg(r.growth)}</td></tr>`).join("")}
      </tbody></table>
    </details>
    ${cov ? `<h3>What Cibo covers</h3>
      <p class="small">Cibo's farm boundary is ${cov.boundary_ha.toLocaleString("en-AU")} ha and takes in ${cov.covered_ha.toLocaleString("en-AU")} of the ${cov.paddock_ha.toLocaleString("en-AU")} ha of paddocks.</p>
      ${outside.length ? `<div class="note warn small">Not in these figures: ${outside.map((s) => `${escapeHtml(s.name)} (${s.area_ha} ha)`).join(", ")}. Ask Cibo Labs to add the purchased country to the farm's record.</div>` : ""}` : ""}
    <p class="muted tiny gap-top">Latest import: ${escapeHtml(last.import_file || "—")}. Importing a newer report adds the months since.</p>
    ${importBtn}`;
  bind();
  drawPasture(el.querySelector("#pastureChart"), farm);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function shiftYear(d, n) { return `${Number(d.slice(0, 4)) + n}${d.slice(4)}`; }

/**
 * The farm median as a 2px line over the middle-half band (same hue, faded),
 * with the district median dashed in neutral grey. Only the latest point is
 * labelled; every month has a tooltip and the table has every value.
 */
function drawPasture(host, rows) {
  if (!host) return;
  const W = Math.max(280, host.clientWidth || 340), H = Math.round(Math.min(260, Math.max(170, W * 0.36)));
  const pad = { l: 42, r: 8, t: 16, b: 20 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const max = Math.max(1000, ...rows.flatMap((r) => [r.p75 || 0, r.p50 || 0, r.ref_p50 || 0]));
  const step = max > 4000 ? 1000 : 500;
  const top = Math.ceil(max / step) * step;
  const t0 = Date.parse(rows[0].date), t1 = Date.parse(rows[rows.length - 1].date);
  const x = (d) => pad.l + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (v) => pad.t + plotH - (v / top) * plotH;

  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Farm pasture biomass, ${rows.length} monthly readings`);
  const add = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.appendChild(n);
    return n;
  };

  for (let v = 0; v <= top; v += step) {
    add("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: v === 0 ? AXIS : GRID, "stroke-width": 1 });
    add("text", { x: pad.l - 5, y: y(v) + 3.5, "text-anchor": "end", "font-size": 10, fill: TICK_TEXT }).textContent = v.toLocaleString("en-AU");
  }
  const firstYear = Number(rows[0].date.slice(0, 4)) + 1, lastYear = Number(rows[rows.length - 1].date.slice(0, 4));
  for (let yr = firstYear; yr <= lastYear; yr++) {
    const xx = x(`${yr}-01-01`);
    add("line", { x1: xx, x2: xx, y1: pad.t + plotH, y2: pad.t + plotH + 3, stroke: AXIS });
    if ((lastYear - yr) % (W < 420 ? 2 : 1) === 0) add("text", { x: xx, y: H - 5, "text-anchor": "middle", "font-size": 10, fill: TICK_TEXT }).textContent = String(yr);
  }

  const band = rows.filter((r) => r.p25 !== null && r.p75 !== null);
  if (band.length > 1) {
    const d = band.map((r, i) => `${i ? "L" : "M"}${x(r.date).toFixed(1)},${y(r.p75).toFixed(1)}`).join(" ")
      + " " + [...band].reverse().map((r) => `L${x(r.date).toFixed(1)},${y(r.p25).toFixed(1)}`).join(" ") + " Z";
    add("path", { d, fill: PASTURE, "fill-opacity": 0.22 });
  }
  const line = (key, attrs) => {
    const pts = rows.filter((r) => r[key] !== null);
    if (pts.length > 1) add("path", { d: pts.map((r, i) => `${i ? "L" : "M"}${x(r.date).toFixed(1)},${y(r[key]).toFixed(1)}`).join(" "), fill: "none", "stroke-linejoin": "round", ...attrs });
  };
  line("ref_p50", { stroke: REF, "stroke-width": 1.5, "stroke-dasharray": "4 3" });
  line("p50", { stroke: PASTURE, "stroke-width": 2 });

  const last = rows[rows.length - 1];
  if (last.p50 !== null) {
    add("circle", { cx: x(last.date), cy: y(last.p50), r: 4, fill: PASTURE, stroke: "#151A1D", "stroke-width": 2 });
    add("text", { x: x(last.date) - 6, y: y(last.p50) - 8, "text-anchor": "end", "font-size": 10, fill: INK }).textContent = Math.round(last.p50).toLocaleString("en-AU");
  }

  // Crosshair: the nearest reading to the pointer.
  const cross = add("line", { x1: 0, x2: 0, y1: pad.t, y2: pad.t + plotH, stroke: AXIS, "stroke-width": 1, visibility: "hidden" });
  const dot = add("circle", { r: 4, fill: PASTURE, stroke: "#151A1D", "stroke-width": 2, visibility: "hidden" });
  add("rect", { x: pad.l, y: pad.t, width: plotW, height: plotH, fill: "transparent" });

  host.innerHTML = "";
  host.appendChild(svg);
  const tip = document.createElement("div");
  tip.className = "charttip";
  tip.hidden = true;
  host.appendChild(tip);
  const xs = rows.map((r) => x(r.date));
  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let i = 0;
    for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] - px) < Math.abs(xs[i] - px)) i = k;
    const r = rows[i];
    cross.setAttribute("x1", xs[i]); cross.setAttribute("x2", xs[i]); cross.setAttribute("visibility", "visible");
    if (r.p50 !== null) { dot.setAttribute("cx", xs[i]); dot.setAttribute("cy", y(r.p50)); dot.setAttribute("visibility", "visible"); }
    tip.textContent = `${fmtDay(r.date)}: median ${kg(r.p50)} · middle half ${r.p25 === null ? "—" : `${Math.round(r.p25).toLocaleString("en-AU")}–${Math.round(r.p75).toLocaleString("en-AU")}`} · district ${kg(r.ref_p50)}`;
    tip.hidden = false;
    // Layout pixels: the panel may be zoomed, and style.left is in its own units.
    const width = host.clientWidth, half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(width - half, Math.max(half, xs[i] * (width / W)))}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", hide);
}
