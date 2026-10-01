/**
 * The Pasture tab: Cibo Labs' monthly pasture biomass for the farm, against
 * Cibo's reference area around it, with a table view and the importer.
 *
 * Whole-farm figures for now. Paddock-by-paddock readings come with a
 * PastureKey download, and the pasture model builds on both.
 */
import { get } from "./api.js";
import { escapeHtml, pastureColour } from "./map.js";

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
    ? '<div class="btns gap-top"><button class="btn" data-import="pasture">Import a Cibo Labs download…</button></div>'
    : "";
  const bind = () => {
    el.querySelectorAll("[data-import]").forEach((b) => { b.onclick = () => ctx.startImport(b.dataset.import); });
    el.querySelectorAll("[data-paddock]").forEach((tr) => { tr.onclick = () => ctx.select(Number(tr.dataset.paddock), true); });
    // Through the CSSOM: the CSP allows that, not style attributes.
    el.querySelectorAll(".swatch[data-colour]").forEach((sw) => { sw.style.background = sw.dataset.colour; });
  };

  const farm = data.farm;
  const paddocks = data.paddocks || [];
  if (!farm.length && !paddocks.length) {
    el.innerHTML = `<p class="muted small">No pasture readings yet. Import PastureKey's paddock readings, or Cibo Labs' Pasture Biomass report, as the .zip Cibo sends.</p>${importBtn}`;
    bind();
    return;
  }

  el.innerHTML = `${paddockSection(paddocks, ctx)}${farm.length ? farmSection(farm, data.coverage, paddocks.length > 0) : ""}${importBtn}`;
  bind();
  if (farm.length) drawPasture(el.querySelector("#pastureChart"), farm);
}

/** Every paddock's latest PastureKey reading: feed on offer, lowest first. */
function paddockSection(latest, ctx) {
  if (!latest.length) return "";
  const byId = new Map(ctx.state.features.filter((f) => f.properties.kind === "paddock").map((f) => [f.id, f]));
  const rows = latest
    .map((p) => {
      const f = byId.get(p.feature_id);
      const area = f?.properties.area_ha || 0;
      return { ...p, name: f?.properties.name || `#${p.feature_id}`, area, foo: (p.tsdm * area) / 1000 };
    })
    .sort((a, b) => a.tsdm - b.tsdm);
  const area = rows.reduce((t, r) => t + r.area, 0);
  const foo = rows.reduce((t, r) => t + r.foo, 0);
  const monthAgoFoo = rows.reduce((t, r) => t + ((r.month_ago ?? r.tsdm) * r.area) / 1000, 0);
  const newest = rows.map((r) => r.date).sort().pop();
  const dm = (t) => `${Math.round(t).toLocaleString("en-AU")} t`;
  const diff = foo - monthAgoFoo;
  return `
    <dl class="facts">
      <dt>Feed on offer</dt><dd><b>${dm(foo)}</b> of dry matter across ${rows.length} paddocks, ${fmtDay(newest)}</dd>
      <dt>Average</dt><dd>${kg(area ? (foo * 1000) / area : null)} <span class="muted">over ${Math.round(area).toLocaleString("en-AU")} ha</span></dd>
      <dt>Last month</dt><dd>${diff >= 0 ? "+" : "−"}${dm(Math.abs(diff))} <span class="muted">(${diff >= 0 ? "+" : "−"}${Math.abs(Math.round((diff / Math.max(1, monthAgoFoo)) * 100))}%)</span></dd>
    </dl>
    <h3>Paddocks · Cibo PastureKey</h3>
    <table class="list">
      <thead><tr><th>Paddock</th><th class="num">Pasture</th><th class="num">Green</th><th>Trend</th><th class="num">Feed</th></tr></thead>
      <tbody>${rows.map((r) => {
        const t = trendWord(r.change_rate);
        return `<tr class="row" data-paddock="${r.feature_id}">
          <td><span class="swatch" data-colour="${pastureColour(r.tsdm)}"></span>${escapeHtml(r.name)}</td>
          <td class="num">${Math.round(r.tsdm).toLocaleString("en-AU")}</td>
          <td class="num muted">${r.green === null ? "—" : Math.round(r.green).toLocaleString("en-AU")}</td>
          <td><span class="trend ${t.cls}">${t.arrow}</span> <span class="muted small">${t.word}</span></td>
          <td class="num">${dm(r.foo)}</td></tr>`;
      }).join("")}</tbody>
    </table>
    <p class="muted tiny">kg of dry matter a hectare, all standing grass (green and dead); "Green" is the growing part. Feed is pasture × paddock area. Lowest first. Switch on "Colour paddocks by pasture" in Layers to see it on the map.</p>`;
}

function farmSection(farm, cov, withPaddocks) {
  const last = farm[farm.length - 1];
  const prev = farm.length > 1 ? farm[farm.length - 2] : null;
  const yearAgo = farm.slice().reverse().find((r) => r.date <= shiftYear(last.date, -1));
  const sameMonth = farm.filter((r) => r.date.slice(5, 7) === last.date.slice(5, 7) && r.date !== last.date && r.p50 !== null);
  const typical = sameMonth.length ? median(sameMonth.map((r) => r.p50)) : null;
  const outside = cov ? cov.short.filter((s) => s.share < 0.5) : [];
  const change = (a, before) => (a === null || !before || before.p50 === null ? "" : ` <span class="muted">(${a >= before.p50 ? "+" : "−"}${Math.abs(Math.round(a - before.p50)).toLocaleString("en-AU")} since ${fmtMonth(before.date)})</span>`);
  return `
    <h3>${withPaddocks ? "The long record · Cibo Pasture Biomass report" : "Pasture on the farm · Cibo Labs"}</h3>
    <dl class="facts">
      <dt>Latest</dt><dd><b>${kg(last.p50)}</b> farm median, ${fmtDay(last.date)}${change(last.p50, prev)}</dd>
      <dt>Middle half</dt><dd>${kg(last.p25)} to ${kg(last.p75)} <span class="muted">across the farm</span></dd>
      <dt>District</dt><dd>${kg(last.ref_p50)} <span class="muted">median in Cibo's reference area</span></dd>
      ${typical !== null ? `<dt>Usual for ${new Date(`${last.date}T00:00:00`).toLocaleDateString("en-AU", { month: "long" })}</dt><dd>${kg(typical)} <span class="muted">(median of ${sameMonth.length} years)</span></dd>` : ""}
      ${yearAgo ? `<dt>A year ago</dt><dd>${kg(yearAgo.p50)} <span class="muted">${fmtDay(yearAgo.date)}</span></dd>` : ""}
    </dl>
    <div class="legend">
      <span><i class="sw sw-pasture"></i>Farm median</span>
      <span><i class="sw sw-pasture-band"></i>Middle half of the farm</span>
      <span><i class="sw sw-ref"></i>District median</span>
    </div>
    <div class="rainchart" id="pastureChart"></div>
    <p class="muted tiny">Monthly, back to 2017, for the farm as Cibo had it registered.${withPaddocks ? " A different method from PastureKey, so its figures run higher: compare it with itself over time, not with the paddock figures above." : ""}</p>
    <details class="gap-top"><summary class="small">Readings as a table</summary>
      <table class="list"><thead><tr><th>Date</th><th class="num">Median</th><th class="num">Middle half</th><th class="num">District</th><th class="num">Growth</th></tr></thead><tbody>
        ${[...farm].reverse().map((r) => `<tr><td>${fmtDay(r.date)}</td><td class="num">${kg(r.p50)}</td>
          <td class="num muted">${r.p25 === null ? "—" : `${Math.round(r.p25).toLocaleString("en-AU")}–${Math.round(r.p75).toLocaleString("en-AU")}`}</td>
          <td class="num">${kg(r.ref_p50)}</td><td class="num muted">${r.growth === null ? "—" : kg(r.growth)}</td></tr>`).join("")}
      </tbody></table>
    </details>
    ${cov && outside.length ? `<div class="note warn small gap-top">This report covers ${cov.boundary_ha.toLocaleString("en-AU")} ha, not ${outside.map((s) => escapeHtml(s.name)).join(", ")}. Ask Cibo Labs to add the purchased country to the farm's record.</div>` : ""}`;
}

/** Words and an arrow for PastureKey's change rate, kg/ha a day. */
export function trendWord(rate) {
  if (rate === null || rate === undefined) return { word: "no trend yet", arrow: "", cls: "" };
  if (rate >= 3) return { word: "growing", arrow: "↑", cls: "up" };
  if (rate <= -3) return { word: "falling", arrow: "↓", cls: "down" };
  return { word: "steady", arrow: "→", cls: "flat" };
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

/* ------------------------------ paddock page ------------------------------ */

/**
 * One paddock's PastureKey history on its page: the latest figures, and a
 * chart of total pasture with its green part, the times stock were in the
 * paddock shaded behind it so the effect of grazing and rest can be seen.
 */
export async function renderPaddockPasture(el, featureId, areaHa, stillCurrent) {
  let series, grazing;
  try {
    [series, grazing] = await Promise.all([
      get(`/api/pasture/paddocks/${featureId}`),
      get(`/api/paddocks/${featureId}/grazing`).catch(() => null),
    ]);
  } catch {
    el.innerHTML = '<p class="muted small">Not available offline.</p>';
    return;
  }
  if (!stillCurrent() || !series.length) { if (!series?.length) el.innerHTML = ""; return; }
  const last = series[series.length - 1];
  const t = trendWord(last.change_rate);
  const monthAgo = series.slice().reverse().find((r) => r.date <= shiftDays(last.date, -28));
  const greenShare = last.green !== null && last.tsdm ? Math.round((last.green / last.tsdm) * 100) : null;
  const periods = (grazing?.history?.periods || []).map((p) => ({ from: p.from, to: p.to, mob: p.mob_name, head: p.head_start }));

  el.innerHTML = `
    <dl class="facts">
      <dt>${fmtDay(last.date)}</dt><dd><b>${kg(last.tsdm)}</b>${last.error ? ` <span class="muted">± ${Math.round(last.error)}</span>` : ""} · <span class="trend ${t.cls}">${t.arrow}</span> ${t.word}${last.change_rate !== null ? ` <span class="muted">(${last.change_rate > 0 ? "+" : ""}${last.change_rate} kg/ha a day)</span>` : ""}</dd>
      <dt>Green</dt><dd>${kg(last.green)}${greenShare !== null ? ` <span class="muted">(${greenShare}% of it)</span>` : ""}</dd>
      <dt>Feed on offer</dt><dd>${areaHa ? `${Math.round((last.tsdm * areaHa) / 1000).toLocaleString("en-AU")} t of dry matter` : "—"}</dd>
      ${monthAgo ? `<dt>A month before</dt><dd>${kg(monthAgo.tsdm)} <span class="muted">${fmtDay(monthAgo.date)}</span></dd>` : ""}
    </dl>
    ${last.captured_pct !== null && last.captured_pct < 50 ? `<p class="muted tiny">The satellite saw only ${Math.round(last.captured_pct)}% of the paddock clearly on that pass (cloud), so the latest figure leans on Cibo's model.</p>` : ""}
    <div class="legend">
      <span><i class="sw sw-pasture"></i>Total pasture</span>
      <span><i class="sw sw-pasture-band"></i>Green part</span>
      ${periods.length ? '<span><i class="sw sw-grazed"></i>Stock in the paddock</span>' : ""}
    </div>
    <div class="rainchart" id="paddockPastureChart"></div>
    <details class="gap-top"><summary class="small">Readings as a table</summary>
      <table class="list"><thead><tr><th>Date</th><th class="num">Pasture</th><th class="num">Green</th><th class="num">Change a day</th><th class="num">Seen clearly</th></tr></thead><tbody>
        ${[...series].reverse().map((r) => `<tr><td>${fmtDay(r.date)}</td><td class="num">${kg(r.tsdm)}</td><td class="num muted">${kg(r.green)}</td>
          <td class="num muted">${r.change_rate === null ? "—" : `${r.change_rate > 0 ? "+" : ""}${r.change_rate}`}</td>
          <td class="num muted">${r.captured_pct === null ? "—" : `${Math.round(r.captured_pct)}%`}</td></tr>`).join("")}
      </tbody></table>
    </details>`;
  drawPaddockPasture(el.querySelector("#paddockPastureChart"), series, periods);
}

const shiftDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

const GRAZED = "#A3B1B7";

function drawPaddockPasture(host, rows, periods) {
  if (!host) return;
  const W = Math.max(280, host.clientWidth || 340), H = Math.round(Math.min(240, Math.max(160, W * 0.34)));
  const pad = { l: 42, r: 8, t: 14, b: 20 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const max = Math.max(500, ...rows.map((r) => r.tsdm + (r.error || 0)));
  const step = max > 4000 ? 1000 : max > 2000 ? 500 : 250;
  const top = Math.ceil(max / step) * step;
  const first = rows[0].date, lastD = rows[rows.length - 1].date;
  const t0 = Date.parse(first), t1 = Date.parse(lastD);
  const x = (d) => pad.l + ((Math.min(t1, Math.max(t0, Date.parse(d))) - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (v) => pad.t + plotH - (v / top) * plotH;

  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Paddock pasture, ${rows.length} readings`);
  const add = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.appendChild(n);
    return n;
  };

  // Grazing periods behind everything, clipped to the chart's dates.
  for (const p of periods) {
    const to = p.to || lastD;
    if (to < first || p.from > lastD) continue;
    add("rect", { x: x(p.from), y: pad.t, width: Math.max(1.5, x(to) - x(p.from)), height: plotH, fill: GRAZED, "fill-opacity": 0.13 });
  }
  for (let v = 0; v <= top; v += step) {
    add("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: v === 0 ? AXIS : GRID, "stroke-width": 1 });
    add("text", { x: pad.l - 5, y: y(v) + 3.5, "text-anchor": "end", "font-size": 10, fill: TICK_TEXT }).textContent = v.toLocaleString("en-AU");
  }
  // Month ticks, labelled every second month on a narrow chart.
  const start = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
  for (let d = new Date(start), i = 0; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 1), i++) {
    const iso = d.toISOString().slice(0, 10);
    if (iso < first) continue;
    const xx = x(iso);
    add("line", { x1: xx, x2: xx, y1: pad.t + plotH, y2: pad.t + plotH + 3, stroke: AXIS });
    const m = d.getUTCMonth();
    if (W >= 460 || m % 2 === 0) {
      add("text", { x: xx, y: H - 5, "text-anchor": "middle", "font-size": 10, fill: TICK_TEXT })
        .textContent = m === 0 ? String(d.getUTCFullYear()) : d.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
    }
  }

  const green = rows.filter((r) => r.green !== null);
  if (green.length > 1) {
    const d = green.map((r, i) => `${i ? "L" : "M"}${x(r.date).toFixed(1)},${y(r.green).toFixed(1)}`).join(" ")
      + ` L${x(green[green.length - 1].date).toFixed(1)},${y(0)} L${x(green[0].date).toFixed(1)},${y(0)} Z`;
    add("path", { d, fill: PASTURE, "fill-opacity": 0.22 });
  }
  add("path", { d: rows.map((r, i) => `${i ? "L" : "M"}${x(r.date).toFixed(1)},${y(r.tsdm).toFixed(1)}`).join(" "), fill: "none", stroke: PASTURE, "stroke-width": 2, "stroke-linejoin": "round" });
  const lr = rows[rows.length - 1];
  add("circle", { cx: x(lr.date), cy: y(lr.tsdm), r: 4, fill: PASTURE, stroke: "#151A1D", "stroke-width": 2 });
  add("text", { x: x(lr.date) - 6, y: y(lr.tsdm) - 8, "text-anchor": "end", "font-size": 10, fill: INK }).textContent = Math.round(lr.tsdm).toLocaleString("en-AU");

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
    const inPaddock = periods.find((p) => p.from <= r.date && (!p.to || p.to >= r.date));
    cross.setAttribute("x1", xs[i]); cross.setAttribute("x2", xs[i]); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", xs[i]); dot.setAttribute("cy", y(r.tsdm)); dot.setAttribute("visibility", "visible");
    tip.textContent = `${fmtDay(r.date)}: ${kg(r.tsdm)}${r.green !== null ? ` · green ${kg(r.green)}` : ""}${inPaddock ? ` · ${inPaddock.mob} in` : ""}`;
    tip.hidden = false;
    const width = host.clientWidth, half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(width - half, Math.max(half, xs[i] * (width / W)))}px`;
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
}
