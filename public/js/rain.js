/**
 * The Rain tab: monthly totals as a column chart with a table view beneath,
 * readings as a list, and a form to record today's gauge.
 *
 * One gauge is shown at a time. Totals from different gauges are never added
 * together — two gauges reading 20 mm is 20 mm of rain, not 40.
 */
import { get, send } from "./api.js";
import { escapeHtml, localGet, localSet } from "./map.js";

const BAR = "#3E9AC9"; // validated for the dark surface: lightness band, chroma, 3:1 contrast
const SVGNS = "http://www.w3.org/2000/svg";

const monthLabel = (m, style = "short") =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-AU", { month: style, year: "numeric" });
const dayLabel = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function renderRain(el, { canEdit, toast }) {
  let data;
  try {
    data = await get("/api/rain");
  } catch (e) {
    el.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
    return;
  }
  const { gauges, readings, monthly } = data;
  const saved = Number(localGet("rainGauge"));
  const gauge = gauges.find((g) => g.id === saved) || gauges[0] || null;

  if (!gauge) {
    el.innerHTML = `<p class="muted small">No rain recorded yet.${canEdit ? " Import AgriWebb's rainfall report from <b>Tools</b>, or record a reading below." : ""}</p>
      ${canEdit ? formHtml([], null) : ""}`;
    if (canEdit) bindForm(el, null, toast, () => renderRain(el, { canEdit, toast }));
    return;
  }

  const series = monthly.slice(-24).map((m) => ({ month: m.month, mm: m.by_gauge[gauge.id] || 0 }));
  const mine = readings.filter((r) => r.gauge_id === gauge.id);
  const year = String(new Date().getFullYear());
  const last12 = monthly.slice(-12).reduce((t, m) => t + (m.by_gauge[gauge.id] || 0), 0);
  const ytd = monthly.filter((m) => m.month.startsWith(year)).reduce((t, m) => t + (m.by_gauge[gauge.id] || 0), 0);
  const lastRain = mine.find((r) => r.mm > 0);
  const daysSince = lastRain ? Math.round((Date.parse(`${localToday()}T00:00:00`) - Date.parse(`${lastRain.date}T00:00:00`)) / 86_400_000) : null;
  const covered = monthly.length < 12 ? ` <span class="muted">(records start ${monthLabel(monthly[0].month)})</span>` : "";

  el.innerHTML = `
    ${gauges.length > 1 ? `<div class="f"><label for="rainGauge">Gauge</label><select id="rainGauge">${gauges.map((g) => `<option value="${g.id}"${g.id === gauge.id ? " selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}</select></div>` : ""}
    <dl class="facts">
      <dt>Last 12 months</dt><dd><b>${Math.round(last12)} mm</b>${covered}</dd>
      <dt>${year} so far</dt><dd>${Math.round(ytd)} mm</dd>
      <dt>Last rain</dt><dd>${lastRain ? `${lastRain.mm} mm on ${dayLabel(lastRain.date)} (${daysSince} days ago)` : "—"}</dd>
    </dl>
    <h3>Monthly rainfall · ${escapeHtml(gauge.name)}${canEdit ? ' <button class="linkbtn" id="rainRename">Rename gauge</button>' : ""}</h3>
    <div class="rainchart" id="rainChart"></div>
    <details class="gap-top"><summary class="small">Monthly totals as a table</summary>
      <table class="list"><thead><tr><th>Month</th><th class="num">Rain</th></tr></thead><tbody>
        ${[...series].reverse().map((s) => `<tr><td>${monthLabel(s.month, "long")}</td><td class="num">${s.mm ? `${Math.round(s.mm)} mm` : '<span class="muted">none recorded</span>'}</td></tr>`).join("")}
      </tbody></table>
    </details>
    ${canEdit ? formHtml(gauges, gauge) : ""}
    <h3>Readings</h3>
    <table class="list"><tbody>${mine.slice(0, 60).map((r) => `
      <tr><td>${dayLabel(r.date)}${r.time ? ` <span class="muted">${escapeHtml(r.time)}</span>` : ""}${r.note ? `<div class="muted tiny">${escapeHtml(r.note)}</div>` : ""}</td>
        <td class="num">${r.mm} mm</td>
        ${canEdit ? `<td class="num"><button class="linkbtn danger-link" data-del="${r.id}" aria-label="Delete this reading">Delete</button></td>` : ""}
      </tr>`).join("")}</tbody></table>
    ${mine.length > 60 ? `<p class="muted small">Showing the latest 60 of ${mine.length}.</p>` : ""}`;

  drawChart(el.querySelector("#rainChart"), series);

  const again = () => renderRain(el, { canEdit, toast });
  const sel = el.querySelector("#rainGauge");
  if (sel) sel.onchange = () => { localSet("rainGauge", sel.value); again(); };
  if (canEdit) {
    el.querySelector("#rainRename").onclick = async () => {
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

/**
 * Monthly columns, drawn as SVG through the DOM (the CSP forbids inline
 * styles, not SVG attributes). Single series, so no legend: the heading
 * names it. Only the wettest month carries a label; every column has a
 * tooltip, and the table below has every value.
 */
function drawChart(host, series) {
  if (!host) return;
  const W = Math.max(280, host.clientWidth || 340), H = 150;
  const pad = { l: 30, r: 4, t: 16, b: 20 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const max = Math.max(10, ...series.map((s) => s.mm));
  const step = max > 200 ? 100 : max > 100 ? 50 : max > 40 ? 20 : 10;
  const top = Math.ceil(max / step) * step;
  const y = (v) => pad.t + plotH - (v / top) * plotH;
  const band = plotW / series.length;
  const barW = Math.min(24, Math.max(3, band - 2)); // 2px surface gap between neighbours

  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Monthly rainfall, ${series.length} months`);
  const add = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };

  for (let v = 0; v <= top; v += step) {
    add("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: v === 0 ? "#3A464C" : "#1F282C", "stroke-width": 1 });
    add("text", { x: pad.l - 5, y: y(v) + 3.5, "text-anchor": "end", "font-size": 10, fill: "#75848B" }).textContent = String(v);
  }

  const wettest = series.reduce((a, b) => (b.mm > a.mm ? b : a), series[0]);
  series.forEach((s, i) => {
    const cx = pad.l + band * i + band / 2;
    if (s.mm > 0) {
      const h = Math.max(2, plotH - (y(s.mm) - pad.t));
      const x = cx - barW / 2, yt = pad.t + plotH - h, r = Math.min(4, barW / 2, h);
      // Rounded at the data end, square on the baseline.
      add("path", {
        d: `M${x},${pad.t + plotH} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${pad.t + plotH} Z`,
        fill: BAR,
      });
    }
    if (s === wettest && s.mm > 0) {
      add("text", { x: cx, y: y(s.mm) - 4, "text-anchor": "middle", "font-size": 10, fill: "#E7EEF0" }).textContent = `${Math.round(s.mm)}`;
    }
    const m = Number(s.month.slice(5, 7));
    if (m === 1 || i === 0) {
      add("text", { x: cx, y: H - 5, "text-anchor": "middle", "font-size": 10, fill: "#75848B" })
        .textContent = m === 1 ? s.month.slice(0, 4) : monthLabel(s.month).split(" ")[0];
    }
    // The hover target is the whole column band, not just the bar.
    const hit = add("rect", { x: pad.l + band * i, y: pad.t, width: band, height: plotH, fill: "transparent" });
    hit.dataset.i = String(i);
  });

  host.innerHTML = "";
  host.appendChild(svg);
  const tip = document.createElement("div");
  tip.className = "charttip";
  tip.hidden = true;
  host.appendChild(tip);

  const show = (e) => {
    const i = e.target.dataset?.i;
    if (i === undefined) { tip.hidden = true; return; }
    const s = series[Number(i)];
    tip.textContent = `${monthLabel(s.month, "long")}: ${s.mm ? `${Math.round(s.mm)} mm` : "none recorded"}`;
    tip.hidden = false;
    const rect = host.getBoundingClientRect();
    const bx = (pad.l + band * Number(i) + band / 2) * (rect.width / W);
    tip.style.left = `${Math.min(rect.width - 10, Math.max(10, bx))}px`;
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; });
}
