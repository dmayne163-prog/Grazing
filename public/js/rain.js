/**
 * The Rain tab: the gauge's monthly totals beside SILO's estimate and the
 * long-term median, how the last 3 and 12 months rank against every year
 * since 1889, yearly totals for the whole record, readings, and a form to
 * record today's gauge.
 *
 * One gauge is shown at a time. Totals from different gauges are never added
 * together — two gauges reading 20 mm is 20 mm of rain, not 40. SILO is shown
 * beside the gauge, never merged into it.
 */
import { get, send } from "./api.js";
import { escapeHtml, localGet, localSet } from "./map.js";

// Validated together on the dark surface (#151A1D): lightness band, chroma,
// colour-blind separation (ΔE 21.8 worst case) and 3:1 contrast.
const GAUGE = "#3E9AC9";
const SILO = "#d95926";
const MEDIAN = "#75848B"; // a reference mark, not a series: the muted ink
const SURFACE = "#151A1D";
const GRID = "#1F282C", AXIS = "#3A464C", TICK_TEXT = "#75848B", INK = "#E7EEF0";
const SVGNS = "http://www.w3.org/2000/svg";

const monthLabel = (m, style = "short") =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-AU", { month: style, year: "numeric" });
const dayLabel = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mm0 = (v) => `${Math.round(v)} mm`;

/** The last n calendar months, oldest first, ending with this month. */
function lastMonths(n) {
  const d = new Date();
  let y = d.getFullYear(), m = d.getMonth() + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, "0")}`);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

export async function renderRain(el, { canEdit, toast }) {
  let data, clim, auto;
  try {
    [data, clim, auto] = await Promise.all([
      get("/api/rain"), get("/api/climate/rain").catch(() => null), get("/api/rain/auto").catch(() => null),
    ]);
  } catch (e) {
    el.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
    return;
  }
  const again = () => renderRain(el, { canEdit, toast });
  const { gauges, readings, monthly } = data;
  const saved = Number(localGet("rainGauge"));
  const gauge = gauges.find((g) => g.id === saved) || gauges[0] || null;
  const haveSilo = !!clim?.monthly?.length;

  if (!gauge && !haveSilo) {
    el.innerHTML = `<p class="muted small">No rain recorded yet.${canEdit ? " Import AgriWebb's rainfall report from <b>Tools</b>, or record a reading below." : ""}</p>
      ${siloStatusHtml(clim, canEdit)}
      ${canEdit ? formHtml([], null) : ""}`;
    bindSiloStatus(el, toast, again);
    if (canEdit) bindForm(el, null, toast, again);
    return;
  }

  const mine = gauge ? readings.filter((r) => r.gauge_id === gauge.id) : [];
  const firstGaugeMonth = mine.length ? mine[mine.length - 1].date.slice(0, 7) : null;
  const gaugeMonth = new Map(monthly.map((m) => [m.month, gauge ? m.by_gauge[gauge.id] || 0 : 0]));
  const siloMonth = new Map((clim?.monthly || []).map((m) => [m.month, m.mm]));
  const series = lastMonths(24).map((month) => ({
    month,
    gauge: firstGaugeMonth && month >= firstGaugeMonth ? gaugeMonth.get(month) || 0 : null,
    silo: siloMonth.has(month) ? siloMonth.get(month) : null,
    median: haveSilo ? clim.median_by_month[Number(month.slice(5)) - 1] : null,
  }));

  const year = String(new Date().getFullYear());
  const last12 = monthly.slice(-12).reduce((t, m) => t + (gauge ? m.by_gauge[gauge.id] || 0 : 0), 0);
  const ytd = monthly.filter((m) => m.month.startsWith(year)).reduce((t, m) => t + (gauge ? m.by_gauge[gauge.id] || 0 : 0), 0);
  const lastRain = mine.find((r) => r.mm > 0);
  const daysSince = lastRain ? Math.max(0, Math.round((Date.parse(`${localToday()}T00:00:00`) - Date.parse(`${lastRain.date}T00:00:00`)) / 86_400_000)) : null;
  const isAuto = !!auto?.configured && gauge?.name.toLowerCase() === auto.gauge.toLowerCase();
  const covered = monthly.length && monthly.length < 12 ? ` <span class="muted">(records start ${monthLabel(monthly[0].month)})</span>` : "";
  const win = (n) => clim?.windows?.find((w) => w.days === n);
  const winHtml = (w) => w
    ? `<b>${mm0(w.mm)}</b> · <span class="decile d${w.decile}">decile ${w.decile}</span> ${escapeHtml(w.rank_note)} <span class="muted">(median ${mm0(w.median)})</span>`
    : "—";

  el.innerHTML = `
    ${gauges.length > 1 ? `<div class="f"><label for="rainGauge">Gauge</label><select id="rainGauge">${gauges.map((g) => `<option value="${g.id}"${g.id === gauge.id ? " selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}</select></div>` : ""}
    ${gauge ? `<dl class="facts">
      <dt>Last 12 months</dt><dd><b>${mm0(last12)}</b> <span class="muted">gauge</span>${covered}</dd>
      <dt>${year} so far</dt><dd>${mm0(ytd)}</dd>
      <dt>Last rain</dt><dd>${lastRain ? `${lastRain.mm} mm on ${dayLabel(lastRain.date)} (${daysSince} days ago)` : "—"}</dd>
    </dl>` : ""}
    ${auto?.configured && (isAuto || !gauges.some((g) => g.name.toLowerCase() === auto.gauge.toLowerCase())) ? autoStatusHtml(auto) : ""}
    ${isAuto ? compareHtml(readings, gauge, gauges) : ""}
    ${haveSilo ? `
    <h3>Against the long record · SILO</h3>
    <dl class="facts">
      <dt>Last 3 months</dt><dd>${winHtml(win(90))}</dd>
      <dt>Last 12 months</dt><dd>${winHtml(win(365))}</dd>
    </dl>
    <p class="muted tiny">Each compared with the same dates in every year since 1889, using SILO for both, so it's like with like. Decile 1 is the driest tenth of years, 10 the wettest.</p>` : ""}
    <h3>Monthly rainfall${gauge ? ` · ${escapeHtml(gauge.name)}` : ""}${canEdit && gauge ? ' <button class="linkbtn" id="rainRename">Rename gauge</button>' : ""}</h3>
    <div class="legend">
      ${gauge ? '<span><i class="sw sw-gauge"></i>Gauge</span>' : ""}
      ${haveSilo ? '<span><i class="sw sw-silo"></i>SILO estimate</span><span><i class="sw sw-median"></i>Median for the month, 1889 on</span>' : ""}
    </div>
    <div class="rainchart" id="rainChart"></div>
    <details class="gap-top"><summary class="small">Monthly totals as a table</summary>
      <table class="list"><thead><tr><th>Month</th>${gauge ? '<th class="num">Gauge</th>' : ""}${haveSilo ? '<th class="num">SILO</th><th class="num">Median</th>' : ""}</tr></thead><tbody>
        ${[...series].reverse().map((s) => `<tr><td>${monthLabel(s.month, "long")}</td>
          ${gauge ? `<td class="num">${s.gauge === null ? '<span class="muted">no record</span>' : s.gauge ? mm0(s.gauge) : '<span class="muted">none</span>'}</td>` : ""}
          ${haveSilo ? `<td class="num">${s.silo === null ? "—" : mm0(s.silo)}</td><td class="num muted">${mm0(s.median)}</td>` : ""}</tr>`).join("")}
      </tbody></table>
    </details>
    ${haveSilo ? `
    <h3>Yearly rainfall since ${clim.annual[0].year} · SILO</h3>
    <div class="rainchart" id="yearChart"></div>
    <details class="gap-top"><summary class="small">Yearly totals as a table</summary>
      <table class="list"><thead><tr><th>Year</th><th class="num">SILO</th></tr></thead><tbody>
        ${[...clim.annual].reverse().map((a) => `<tr><td>${a.year}${a.complete ? "" : ' <span class="muted">so far</span>'}</td><td class="num">${mm0(a.mm)}</td></tr>`).join("")}
      </tbody></table>
    </details>` : ""}
    ${siloStatusHtml(clim, canEdit)}
    ${canEdit ? formHtml(gauges, isAuto ? handGauge(gauges, gauge) : gauge) : ""}
    ${gauge ? `<h3>Readings</h3>
    <table class="list"><tbody>${mine.slice(0, 60).map((r) => `
      <tr><td>${dayLabel(r.date)}${r.date > localToday() ? ' <span class="muted">so far</span>' : ""}${r.time ? ` <span class="muted">${escapeHtml(r.time)}</span>` : ""}${r.note ? `<div class="muted tiny">${escapeHtml(r.note)}</div>` : ""}</td>
        <td class="num">${r.mm} mm</td>
        ${canEdit ? `<td class="num"><button class="linkbtn danger-link" data-del="${r.id}" aria-label="Delete this reading">Delete</button></td>` : ""}
      </tr>`).join("")}</tbody></table>
    ${mine.length > 60 ? `<p class="muted small">Showing the latest 60 of ${mine.length}.</p>` : ""}` : ""}`;

  drawMonthly(el.querySelector("#rainChart"), series);
  if (haveSilo) drawYearly(el.querySelector("#yearChart"), clim.annual, clim.median_annual);
  bindSiloStatus(el, toast, again);

  const sel = el.querySelector("#rainGauge");
  if (sel) sel.onchange = () => { localSet("rainGauge", sel.value); again(); };
  if (canEdit) {
    const rename = el.querySelector("#rainRename");
    if (rename) rename.onclick = async () => {
      const name = prompt("Gauge name", gauge.name);
      if (!name || name.trim() === gauge.name) return;
      try {
        await send("PATCH", `/api/rain/gauges/${gauge.id}`, { name });
        again();
      } catch (e) {
        toast(e.message, { error: true });
      }
    };
    bindForm(el, gauge, toast, again);
    el.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Delete this reading?")) return;
        try {
          await send("DELETE", `/api/rain/${b.dataset.del}`);
          toast("Reading deleted");
          again();
        } catch (e) {
          toast(e.message, { error: true });
        }
      };
    });
  }
}

/** Whether the automatic gauge is reaching its Cerbo, and what it has counted. */
function autoStatusHtml(a) {
  const when = (ts) => new Date(ts).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const state = !a.connected
    ? `<span class="bad">Can't reach the Cerbo${a.error ? ` (${escapeHtml(a.error)})` : ""}.</span> It keeps counting; the app catches up when it's back.`
    : !a.meters.length
      ? "Connected to the Cerbo, waiting for a pulse meter: set the gauge's digital input to <b>Pulse meter</b>."
      : `Counting tips on pulse meter ${a.instance ?? a.meters[0]}, ${a.mm_per_tip} mm each. ${a.since_9am_mm} mm since 9am${a.last_tip_at ? `, last tip ${when(a.last_tip_at)}` : ""}.`;
  return `<p class="muted tiny gap-top"><b>${escapeHtml(a.gauge)}:</b> ${state}</p>`;
}

/**
 * The automatic gauge beside another, rain day by rain day (9am to 9am), from
 * the automatic gauge's first reading on: what decides whether it can be
 * trusted to replace the manual one.
 */
function compareHtml(readings, gauge, gauges) {
  const others = gauges.filter((g) => g.id !== gauge.id);
  if (!others.length) return "";
  const other = handGauge(gauges, gauge);
  const mine = readings.filter((r) => r.gauge_id === gauge.id);
  if (!mine.length) return "";
  const from = mine[mine.length - 1].date;
  const day = new Map();
  for (const r of readings) {
    if (r.date < from || (r.gauge_id !== gauge.id && r.gauge_id !== other.id)) continue;
    const d = day.get(r.date) || { a: 0, m: null };
    if (r.gauge_id === gauge.id) d.a += r.mm; else d.m = (d.m || 0) + r.mm;
    day.set(r.date, d);
  }
  const rows = [...day].filter(([, d]) => d.a > 0 || d.m > 0).sort((x, y) => y[0].localeCompare(x[0]));
  if (!rows.length) return "";
  const both = rows.filter(([, d]) => d.m !== null);
  const tA = both.reduce((t, [, d]) => t + d.a, 0), tM = both.reduce((t, [, d]) => t + d.m, 0);
  const diff = (a, m) => (m === null ? "—" : `${a - m >= 0 ? "+" : "−"}${Math.abs(Math.round((a - m) * 10) / 10)}`);
  return `<details class="gap-top"><summary class="small">Against ${escapeHtml(other.name)}, day by day</summary>
    <table class="list"><thead><tr><th>Rain day <span class="muted">to 9am</span></th><th class="num">Automatic</th><th class="num">Manual</th><th class="num">Diff</th></tr></thead><tbody>
      ${rows.slice(0, 60).map(([d, x]) => `<tr><td>${dayLabel(d)}</td><td class="num">${Math.round(x.a * 10) / 10}</td><td class="num">${x.m === null ? '<span class="muted">not read</span>' : x.m}</td><td class="num">${diff(x.a, x.m)}</td></tr>`).join("")}
    </tbody>${both.length ? `<tfoot><tr><td>${both.length} day${both.length === 1 ? "" : "s"} read on both</td><td class="num">${Math.round(tA * 10) / 10}</td><td class="num">${Math.round(tM * 10) / 10}</td><td class="num">${tM ? `${tA >= tM ? "+" : "−"}${Math.abs(Math.round(((tA - tM) / tM) * 100))}%` : "—"}</td></tr></tfoot>` : ""}</table>
    <p class="muted tiny">Each day is the 24 hours to 9am, booked to the day it ends, the way a gauge read at 9am is. A manual reading booked to the wrong day shows as a pair of opposite differences.</p>
  </details>`;
}

/** The gauge read by hand to set beside the automatic one: "manual" in its name, else any other. */
function handGauge(gauges, auto) {
  const others = gauges.filter((g) => g.id !== auto.id);
  return others.find((g) => /manual/i.test(g.name)) || others[0] || null;
}

/** Where the SILO data is up to, and a way to fetch it now. */
function siloStatusHtml(clim, canEdit) {
  if (!clim) return "";
  const s = clim.status;
  if (!s.configured) return '<p class="muted tiny gap-top">SILO isn\'t set up on this server (SILO_EMAIL).</p>';
  const failed = s.cells.filter((c) => c.error);
  const text = s.syncing ? "Fetching SILO data…"
    : s.last_date ? `SILO data to ${dayLabel(s.last_date)}, from ${s.cells.length} grid point${s.cells.length === 1 ? "" : "s"} covering the paddocks. Updated each morning.`
    : "SILO data hasn't been fetched yet.";
  return `<p class="muted tiny gap-top">${text}${failed.length ? ` <span class="bad">${failed.length} grid point${failed.length === 1 ? "" : "s"} failed: ${escapeHtml(failed[0].error)}</span>` : ""}
    ${canEdit && !s.syncing && (failed.length || !s.last_date) ? ' <button class="linkbtn" id="siloSync">Fetch now</button>' : ""}</p>`;
}

function bindSiloStatus(el, toast, again) {
  const b = el.querySelector("#siloSync");
  if (!b) return;
  b.onclick = async () => {
    try {
      await send("POST", "/api/climate/sync", {});
      toast("Fetching from SILO. The whole record takes about half a minute.");
      setTimeout(again, 30_000);
      again();
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
}

function formHtml(gauges, gauge) {
  return `
    <h3>Record rain</h3>
    <div class="row2">
      <div class="f"><label for="rDate">Date</label><input id="rDate" type="date" value="${localToday()}" max="${localToday()}"></div>
      <div class="f"><label for="rMm">Rain (mm)</label><input id="rMm" type="number" min="0" step="0.5" inputmode="decimal"></div>
    </div>
    <div class="f"><label for="rGauge">Gauge</label>
      <input id="rGauge" list="rGauges" value="${escapeHtml(gauge?.name || "")}" placeholder="e.g. Homestead" autocomplete="off">
      <datalist id="rGauges">${gauges.map((g) => `<option value="${escapeHtml(g.name)}">`).join("")}</datalist>
    </div>
    <div class="f"><label for="rNote">Note</label><input id="rNote" placeholder="optional" autocomplete="off"></div>
    <div class="btns"><button class="btn primary" id="rSave">Save reading</button></div>`;
}

function bindForm(el, gauge, toast, done) {
  el.querySelector("#rSave").onclick = async () => {
    const mm = el.querySelector("#rMm").value;
    if (mm === "") { toast("Enter the rainfall in mm", { error: true }); return; }
    try {
      await send("POST", "/api/rain", {
        gauge: el.querySelector("#rGauge").value,
        date: el.querySelector("#rDate").value,
        mm: Number(mm),
        note: el.querySelector("#rNote").value,
      });
      toast(`Saved ${mm} mm`);
      done();
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
}


/* --------------------------------- charts ---------------------------------- */
// Drawn as SVG through the DOM: the CSP forbids inline styles, not SVG
// attributes. Every chart has a hover/tap tooltip and a table view beside it.

function frame(host, W, H, label) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const add = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };
  return { svg, add };
}

function niceTop(max) {
  const step = max > 800 ? 400 : max > 400 ? 200 : max > 200 ? 100 : max > 100 ? 50 : max > 40 ? 20 : 10;
  return { step, top: Math.ceil(max / step) * step };
}

function yAxis(add, pad, W, y, top, step) {
  for (let v = 0; v <= top; v += step) {
    add("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: v === 0 ? AXIS : GRID, "stroke-width": 1 });
    add("text", { x: pad.l - 5, y: y(v) + 3.5, "text-anchor": "end", "font-size": 10, fill: TICK_TEXT }).textContent = String(v);
  }
}

/** A column rounded at its data end and square on the baseline. */
function column(add, x, w, base, yt, fill, extra = {}) {
  const h = base - yt, r = Math.min(4, w / 2, h);
  if (h <= 0) return;
  add("path", {
    d: r >= 1
      ? `M${x},${base} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + w - r} Q${x + w},${yt} ${x + w},${yt + r} V${base} Z`
      : `M${x},${base} V${yt} H${x + w} V${base} Z`,
    fill, ...extra,
  });
}

/** Hover and tap: the whole column band is the target, not just the mark. */
function tooltip(host, svg, W, bandX, text) {
  const tip = document.createElement("div");
  tip.className = "charttip";
  tip.hidden = true;
  host.appendChild(tip);
  const show = (e) => {
    const i = e.target.dataset?.i;
    if (i === undefined) { tip.hidden = true; return; }
    tip.textContent = text(Number(i));
    tip.hidden = false;
    // Layout widths, not getBoundingClientRect: the panel may be zoomed, and
    // style.left is in the panel's own (unzoomed) pixels.
    const width = host.clientWidth;
    const half = tip.offsetWidth / 2;
    const bx = bandX(Number(i)) * (width / W);
    tip.style.left = `${Math.min(width - half, Math.max(half, bx))}px`;
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; });
}

/**
 * Gauge columns, SILO as a ringed dot, and the month's long-term median as a
 * short grey bar across the column. Only the wettest gauge month is labelled.
 */
function drawMonthly(host, series) {
  if (!host) return;
  const W = Math.max(280, host.clientWidth || 340), H = Math.round(Math.min(240, Math.max(160, W * 0.34)));
  const pad = { l: 30, r: 4, t: 16, b: 20 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const { step, top } = niceTop(Math.max(10, ...series.flatMap((s) => [s.gauge || 0, s.silo || 0, s.median || 0])));
  const y = (v) => pad.t + plotH - (v / top) * plotH;
  const base = pad.t + plotH;
  const band = plotW / series.length;
  const barW = Math.min(22, Math.max(3, band - 2)); // 2px surface gap between neighbours
  const cxOf = (i) => pad.l + band * i + band / 2;
  const { svg, add } = frame(host, W, H, `Monthly rainfall, ${series.length} months`);
  yAxis(add, pad, W, y, top, step);

  const wettest = series.reduce((a, b) => ((b.gauge || 0) > (a.gauge || 0) ? b : a), series[0]);
  series.forEach((s, i) => {
    const cx = cxOf(i);
    if (s.gauge > 0) column(add, cx - barW / 2, barW, base, Math.min(base - 2, y(s.gauge)), GAUGE);
    if (s.median !== null) {
      const half = Math.max(4, Math.min(barW / 2 + 2, band / 2 - 1));
      add("line", { x1: cx - half, x2: cx + half, y1: y(s.median), y2: y(s.median), stroke: MEDIAN, "stroke-width": 2, "stroke-linecap": "round" });
    }
    if (s.silo !== null) add("circle", { cx, cy: y(s.silo), r: 4, fill: SILO, stroke: SURFACE, "stroke-width": 2 });
    if (s === wettest && s.gauge > 0) {
      add("text", { x: cx, y: Math.min(y(s.gauge), s.silo !== null ? y(s.silo) - 4 : Infinity) - 5, "text-anchor": "middle", "font-size": 10, fill: INK }).textContent = `${Math.round(s.gauge)}`;
    }
    const m = Number(s.month.slice(5, 7));
    if (m === 1 || i === 0) {
      add("text", { x: cx, y: H - 5, "text-anchor": "middle", "font-size": 10, fill: TICK_TEXT })
        .textContent = m === 1 ? s.month.slice(0, 4) : `${monthLabel(s.month).split(" ")[0]} '${s.month.slice(2, 4)}`;
    }
    add("rect", { x: pad.l + band * i, y: pad.t, width: band, height: plotH, fill: "transparent", "data-i": i });
  });

  host.innerHTML = "";
  host.appendChild(svg);
  tooltip(host, svg, W, cxOf, (i) => {
    const s = series[i];
    const parts = [];
    if (s.gauge !== null) parts.push(`gauge ${s.gauge ? mm0(s.gauge) : "none"}`);
    if (s.silo !== null) parts.push(`SILO ${mm0(s.silo)}`);
    if (s.median !== null) parts.push(`median ${mm0(s.median)}`);
    return `${monthLabel(s.month, "long")}: ${parts.join(" · ") || "no record"}`;
  });
}

/**
 * Every year's SILO total, with the median year as a dashed reference line
 * labelled at its end. The year in progress is drawn faded: it isn't over.
 */
function drawYearly(host, annual, medianYear) {
  if (!host || !annual.length) return;
  const W = Math.max(280, host.clientWidth || 340), H = Math.round(Math.min(220, Math.max(150, W * 0.3)));
  const pad = { l: 34, r: 4, t: 14, b: 20 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const { step, top } = niceTop(Math.max(...annual.map((a) => a.mm)));
  const y = (v) => pad.t + plotH - (v / top) * plotH;
  const base = pad.t + plotH;
  const band = plotW / annual.length;
  const barW = Math.max(1, band - (band > 4 ? 1 : 0.5));
  const cxOf = (i) => pad.l + band * i + band / 2;
  const { svg, add } = frame(host, W, H, `Yearly rainfall, ${annual[0].year} to ${annual[annual.length - 1].year}`);
  yAxis(add, pad, W, y, top, step);

  annual.forEach((a, i) => {
    column(add, cxOf(i) - barW / 2, barW, base, Math.min(base - 1, y(a.mm)), SILO, a.complete ? {} : { "fill-opacity": 0.4 });
    if (a.year % 20 === 0) {
      add("text", { x: cxOf(i), y: H - 5, "text-anchor": "middle", "font-size": 10, fill: TICK_TEXT }).textContent = String(a.year);
    }
    add("rect", { x: pad.l + band * i, y: pad.t, width: band, height: plotH, fill: "transparent", "data-i": i });
  });
  if (medianYear) {
    add("line", { x1: pad.l, x2: W - pad.r, y1: y(medianYear), y2: y(medianYear), stroke: INK, "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0.7 });
    add("text", { x: pad.l + 3, y: y(medianYear) - 4, "font-size": 10, fill: INK }).textContent = `median ${mm0(medianYear)}`;
  }

  host.innerHTML = "";
  host.appendChild(svg);
  tooltip(host, svg, W, cxOf, (i) => {
    const a = annual[i];
    const vs = medianYear && a.complete ? ` (${a.mm >= medianYear ? "+" : "−"}${mm0(Math.abs(a.mm - medianYear))} on the median)` : "";
    return `${a.year}: ${mm0(a.mm)}${a.complete ? "" : " so far"}${vs}`;
  });
}
