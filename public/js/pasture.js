/**
 * The Pasture tab: Cibo Labs' monthly pasture biomass for the farm, against
 * Cibo's reference area around it, with a table view and the importer.
 *
 * Whole-farm figures for now. Paddock-by-paddock readings come with a
 * PastureKey download, and the pasture model builds on both.
 */
import { get, send } from "./api.js";
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

  el.innerHTML = `${paddocks.length ? '<div id="outlook"><h3>Outlook</h3><p class="muted small">Working out the outlook…</p></div>' : ""}${paddockSection(paddocks, ctx)}${farm.length ? farmSection(farm, data.coverage, paddocks.length > 0) : ""}${importBtn}`;
  bind();
  if (farm.length) drawPasture(el.querySelector("#pastureChart"), farm);
  loadOutlook(el.querySelector("#outlook"), ctx);
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
      <span class="ol-key" hidden><i class="sw sw-outlook"></i>Outlook: past seasons' range, median dashed</span>
    </div>
    <div class="rainchart" id="paddockPastureChart"></div>
    <div id="paddockOutlook"></div>
    <details class="gap-top"><summary class="small">Readings as a table</summary>
      <table class="list"><thead><tr><th>Date</th><th class="num">Pasture</th><th class="num">Green</th><th class="num">Change a day</th><th class="num">Seen clearly</th></tr></thead><tbody>
        ${[...series].reverse().map((r) => `<tr><td>${fmtDay(r.date)}</td><td class="num">${kg(r.tsdm)}</td><td class="num muted">${kg(r.green)}</td>
          <td class="num muted">${r.change_rate === null ? "—" : `${r.change_rate > 0 ? "+" : ""}${r.change_rate}`}</td>
          <td class="num muted">${r.captured_pct === null ? "—" : `${Math.round(r.captured_pct)}%`}</td></tr>`).join("")}
      </tbody></table>
    </details>`;
  drawPaddockPasture(el.querySelector("#paddockPastureChart"), series, periods);

  // The outlook can take a few seconds the first time; the readings show meanwhile.
  let ol = null;
  try { ol = await get(`/api/pasture/outlook/${featureId}`); } catch { return; }
  if (!ol || !stillCurrent() || !el.isConnected || !ol.series?.length) return;
  drawPaddockPasture(el.querySelector("#paddockPastureChart"), series, periods, ol);
  el.querySelector(".ol-key").hidden = false;
  const R = ol.residual.toLocaleString("en-AU");
  const span = (v) => `${Math.round(v.median).toLocaleString("en-AU")} <span class="muted">(${Math.round(v.low).toLocaleString("en-AU")}–${Math.round(v.high).toLocaleString("en-AU")})</span>`;
  el.querySelector("#paddockOutlook").innerHTML = `
    <dl class="facts gap-top">
      <dt>Today</dt><dd>about <b>${kg(ol.now)}</b> <span class="muted">estimated on from the last reading</span></dd>
      ${ol.days_left ? `<dt>To ${R} kg/ha</dt><dd><b>${daysText(ol.days_left.median)} days</b> <span class="muted">with the stock now in it (${ol.ae_per_ha.toFixed(2)} AE/ha); ${daysText(ol.days_left.low)} in a poor run, ${daysText(ol.days_left.high)} in a good one</span></dd>` : ""}
      <dt>In 3 months</dt><dd>${span(ol.at["90"])} kg/ha</dd>
      <dt>In 6 months</dt><dd>${span(ol.at["180"])} kg/ha</dd>
      ${ol.capacity_ae !== null ? `<dt>Carries</dt><dd>about ${ol.capacity_ae.toLocaleString("en-AU")} AE long term <span class="muted">(${(ol.capacity_ae / ol.area_ha).toFixed(2)} AE/ha)</span></dd>` : ""}
    </dl>
    <p class="muted tiny">The outlook runs on from today with the weather of each year since 1890${ol.ae_per_ha > 0 ? " and the stock staying put" : ", no stock in it"}; brackets are the low and high of those seasons (20th and 80th percentile).${ol.multiplier !== null ? ` This paddock grows ${Math.round(ol.multiplier * 100)}% of the farm's typical rate, judged from its readings.` : ""}</p>`;
}

const shiftDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

const GRAZED = "#A3B1B7";

function drawPaddockPasture(host, rows, periods, ol = null) {
  if (!host) return;
  const W = Math.max(280, host.clientWidth || 340), H = Math.round(Math.min(250, Math.max(170, W * 0.36)));
  const pad = { l: 42, r: 8, t: 14, b: 20 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const fan = ol?.series?.length ? ol.series : [];
  const max = Math.max(500, ...rows.map((r) => r.tsdm + (r.error || 0)), ...fan.map((f) => f.p90), ol?.residual || 0);
  const step = max > 4000 ? 1000 : max > 2000 ? 500 : 250;
  const top = Math.ceil(max / step) * step;
  const first = rows[0].date;
  const lastD = fan.length ? fan[fan.length - 1].date : rows[rows.length - 1].date;
  const t0 = Date.parse(first), t1 = Date.parse(lastD);
  const x = (d) => pad.l + ((Math.min(t1, Math.max(t0, Date.parse(d))) - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (v) => pad.t + plotH - (v / top) * plotH;

  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Paddock pasture, ${rows.length} readings${fan.length ? ", and the outlook" : ""}`);
  const add = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.appendChild(n);
    return n;
  };
  const path = (pts) => pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const band = (lo, hi, opacity) => {
    const d = path(fan.map((f) => [x(f.date), y(f[hi])])) + " " + [...fan].reverse().map((f) => `L${x(f.date).toFixed(1)},${y(f[lo]).toFixed(1)}`).join(" ") + " Z";
    add("path", { d, fill: PASTURE, "fill-opacity": opacity });
  };

  // Grazing periods behind everything, clipped to the chart's dates.
  for (const p of periods) {
    const to = p.to || rows[rows.length - 1].date;
    if (to < first || p.from > lastD) continue;
    add("rect", { x: x(p.from), y: pad.t, width: Math.max(1.5, x(to) - x(p.from)), height: plotH, fill: GRAZED, "fill-opacity": 0.13 });
  }
  for (let v = 0; v <= top; v += step) {
    add("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: v === 0 ? AXIS : GRID, "stroke-width": 1 });
    add("text", { x: pad.l - 5, y: y(v) + 3.5, "text-anchor": "end", "font-size": 10, fill: TICK_TEXT }).textContent = v.toLocaleString("en-AU");
  }
  // Month ticks; on a narrow or long chart only every second or third month is labelled.
  const months = Math.round((t1 - t0) / (30.4 * 86_400_000));
  const every = W < 460 ? (months > 14 ? 3 : 2) : months > 16 ? 2 : 1;
  for (let d = new Date(`${first.slice(0, 7)}-01T00:00:00Z`); d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso < first) continue;
    const xx = x(iso), m = d.getUTCMonth();
    add("line", { x1: xx, x2: xx, y1: pad.t + plotH, y2: pad.t + plotH + 3, stroke: AXIS });
    if (m % every === 0) {
      add("text", { x: xx, y: H - 5, "text-anchor": "middle", "font-size": 10, fill: TICK_TEXT })
        .textContent = m === 0 ? String(d.getUTCFullYear()) : d.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
    }
  }

  const green = rows.filter((r) => r.green !== null);
  if (green.length > 1) {
    const d = path(green.map((r) => [x(r.date), y(r.green)])) + ` L${x(green[green.length - 1].date).toFixed(1)},${y(0)} L${x(green[0].date).toFixed(1)},${y(0)} Z`;
    add("path", { d, fill: PASTURE, "fill-opacity": 0.22 });
  }

  if (fan.length) {
    band("p10", "p90", 0.1);
    band("p20", "p80", 0.2);
    add("path", { d: path(fan.map((f) => [x(f.date), y(f.p50)])), fill: "none", stroke: PASTURE, "stroke-width": 2, "stroke-dasharray": "5 4" });
    const xt = x(ol.as_of);
    add("line", { x1: xt, x2: xt, y1: pad.t, y2: pad.t + plotH, stroke: INK, "stroke-width": 1, opacity: 0.35 });
    add("text", { x: xt + 4, y: pad.t + 10, "font-size": 10, fill: TICK_TEXT }).textContent = "today";
    const yr = y(ol.residual);
    add("line", { x1: pad.l, x2: W - pad.r, y1: yr, y2: yr, stroke: "#E0A845", "stroke-width": 1.5, "stroke-dasharray": "3 3" });
    add("text", { x: W - pad.r - 2, y: yr - 4, "text-anchor": "end", "font-size": 10, fill: "#E0A845" }).textContent = `graze to ${ol.residual.toLocaleString("en-AU")}`;
  }

  add("path", { d: path(rows.map((r) => [x(r.date), y(r.tsdm)])), fill: "none", stroke: PASTURE, "stroke-width": 2, "stroke-linejoin": "round" });
  const lr = rows[rows.length - 1];
  add("circle", { cx: x(lr.date), cy: y(lr.tsdm), r: 4, fill: PASTURE, stroke: "#151A1D", "stroke-width": 2 });
  if (!fan.length) add("text", { x: x(lr.date) - 6, y: y(lr.tsdm) - 8, "text-anchor": "end", "font-size": 10, fill: INK }).textContent = Math.round(lr.tsdm).toLocaleString("en-AU");

  const cross = add("line", { x1: 0, x2: 0, y1: pad.t, y2: pad.t + plotH, stroke: AXIS, "stroke-width": 1, visibility: "hidden" });
  const dot = add("circle", { r: 4, fill: PASTURE, stroke: "#151A1D", "stroke-width": 2, visibility: "hidden" });
  add("rect", { x: pad.l, y: pad.t, width: plotW, height: plotH, fill: "transparent" });

  host.innerHTML = "";
  host.appendChild(svg);
  const tip = document.createElement("div");
  tip.className = "charttip";
  tip.hidden = true;
  host.appendChild(tip);
  // Readings, then the outlook's points beyond the last reading: one list to snap to.
  const points = [
    ...rows.map((r) => ({ x: x(r.date), y: y(r.tsdm), r })),
    ...fan.filter((f) => f.date > lr.date).map((f) => ({ x: x(f.date), y: y(f.p50), f })),
  ];
  const show = (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = points[0];
    for (const pt of points) if (Math.abs(pt.x - px) < Math.abs(best.x - px)) best = pt;
    cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y); dot.setAttribute("visibility", "visible");
    if (best.r) {
      const r = best.r;
      const inPaddock = periods.find((p) => p.from <= r.date && (!p.to || p.to >= r.date));
      tip.textContent = `${fmtDay(r.date)}: ${kg(r.tsdm)}${r.green !== null ? ` · green ${kg(r.green)}` : ""}${inPaddock ? ` · ${inPaddock.mob} in` : ""}`;
    } else {
      const f = best.f;
      tip.textContent = `${fmtDay(f.date)}, outlook: median ${kg(f.p50)} · low ${Math.round(f.p20).toLocaleString("en-AU")} · high ${Math.round(f.p80).toLocaleString("en-AU")}`;
    }
    tip.hidden = false;
    const width = host.clientWidth, half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(width - half, Math.max(half, best.x * (width / W)))}px`;
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
}


/* -------------------------------- outlook ---------------------------------- */

const t0 = (v) => `${Math.round(v).toLocaleString("en-AU")} t`;
const daysText = (d) => (d === null ? "180+" : String(d));

/**
 * The model's view of the place: stock against long-term carrying capacity,
 * feed above the residual now and ahead, and days of grazing left in each
 * stocked paddock. Loaded on its own: the first working-out takes seconds.
 */
async function loadOutlook(host, ctx) {
  if (!host) return;
  let o;
  try {
    o = await get("/api/pasture/outlook");
  } catch (e) {
    host.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!host.isConnected) return;
  if (!o || !o.property) {
    host.innerHTML = '<p class="muted small">The outlook needs PastureKey paddock readings and SILO weather.</p>';
    return;
  }
  const p = o.property, R = o.residual;
  const names = new Map(o.paddocks.map((x) => [x.id, x]));
  const stocked = o.paddocks.filter((x) => x.ae_per_ha > 0 && x.days_left)
    .sort((a, b) => (a.days_left.median ?? 999) - (b.days_left.median ?? 999));
  const f = o.fit;
  host.innerHTML = `
    <h3>Outlook · from ${fmtDay(o.as_of)}</h3>
    <dl class="facts">
      <dt>Stock</dt><dd><b>${p.ae.toLocaleString("en-AU")} AE</b> <span class="muted">on hand</span></dd>
      <dt>Carrying capacity</dt><dd>about <b>${p.capacity_ae.toLocaleString("en-AU")} AE</b> <span class="muted">long term, eating a quarter of a median year's growth</span></dd>
    </dl>
    <p class="small">Feed above ${R.toLocaleString("en-AU")} kg/ha across the place, with today's stock:</p>
    <table class="list outlook">
      <thead><tr><th></th><th class="num">Low</th><th class="num">Median</th><th class="num">High</th></tr></thead>
      <tbody>
        <tr><td>Now</td><td class="num"></td><td class="num"><b>${t0(p.feed_t)}</b></td><td class="num"></td></tr>
        ${[["30", "In a month"], ["90", "In 3 months"], ["180", "In 6 months"]].map(([k, label]) => `
          <tr><td>${label}</td><td class="num muted">${t0(p.at[k].low)}</td><td class="num">${t0(p.at[k].median)}</td><td class="num muted">${t0(p.at[k].high)}</td></tr>`).join("")}
      </tbody>
    </table>
    ${stocked.length ? `
    <p class="small gap-top">Days until each stocked paddock is down to ${R.toLocaleString("en-AU")} kg/ha, if the stock stay:</p>
    <table class="list outlook">
      <thead><tr><th>Paddock</th><th class="num">AE/ha</th><th class="num">Now</th><th class="num">Low</th><th class="num">Median</th><th class="num">High</th></tr></thead>
      <tbody>${stocked.map((x) => `
        <tr class="row" data-paddock="${x.id}">
          <td>${escapeHtml(names.get(x.id).name)}</td>
          <td class="num muted">${x.ae_per_ha.toFixed(2)}</td>
          <td class="num">${Math.round(x.now).toLocaleString("en-AU")}</td>
          <td class="num ${x.days_left.low !== null && x.days_left.low < 30 ? "bad" : ""}">${daysText(x.days_left.low)}</td>
          <td class="num"><b>${daysText(x.days_left.median)}</b></td>
          <td class="num muted">${daysText(x.days_left.high)}</td>
        </tr>`).join("")}
      </tbody>
    </table>` : ""}
    <p class="muted tiny">Low, median and high are the 20th, 50th and 80th percentile of running the next six months with the weather of each of the ${o.years} years since 1890, from today's soil moisture. "180+" means it lasts beyond the six months.</p>
    ${ctx.canEdit ? `<div class="row2 gap-top residual">
      <label for="resid" class="small">Graze down to</label>
      <input id="resid" type="number" min="200" max="4000" step="50" value="${R}" inputmode="numeric"> <span class="small muted">kg/ha</span>
      <button class="btn" id="residSave">Save</button>
    </div>` : ""}
    ${f ? `<details class="gap-top"><summary class="small">How good is the model?</summary>
      <p class="small">Fitted to ${f.intervals.toLocaleString("en-AU")} stretches of PastureKey readings against the stock records and SILO weather. Over ${f.lead} days its typical miss is <b>±${f.mae} kg/ha</b>, against ±${f.persistence_mae} for assuming nothing changes. Green pasture: ±${f.green_mae}.</p>
      <p class="small muted">${f.set_aside} stretches were left out where Cibo's total rose with no growth and no rain, which standing grass can't do (dry 2026 winter). Intake is set at 8 kg of dry matter per AE a day, not fitted. It refits itself with every new PastureKey import, so it should sharpen as the record lengthens: one year is a short history.</p>
    </details>` : ""}`;
  host.querySelectorAll("[data-paddock]").forEach((tr) => { tr.onclick = () => ctx.select(Number(tr.dataset.paddock), true); });
  const save = host.querySelector("#residSave");
  if (save) save.onclick = async () => {
    try {
      await send("PUT", "/api/pasture/residual", { kg_ha: Number(host.querySelector("#resid").value) });
      host.innerHTML = '<p class="muted small">Working out the outlook…</p>';
      loadOutlook(host, ctx);
    } catch (e) {
      ctx.toast(e.message, { error: true });
    }
  };
}
