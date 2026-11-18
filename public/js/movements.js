/**
 * Cattle on and off the property: pick a start and finish date and see every
 * consignment that came in or went out, with the NLIS and scales records for
 * the same days beside each one so a wrong head count stands out. Deaths and
 * recounts in the period are listed underneath, since they move the numbers
 * too. Own and agisted cattle are counted together unless asked to split.
 */
import { get } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

/** Financial years run July to June. */
function presets() {
  const now = new Date();
  const fy = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return [
    ["fy", "This financial year", `${fy}-07-01`, iso(now)],
    ["lastfy", "Last financial year", `${fy - 1}-07-01`, `${fy}-06-30`],
    ["12m", "Last 12 months", iso(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)), iso(now)],
    ["cy", "This calendar year", `${now.getFullYear()}-01-01`, iso(now)],
  ];
}

const KEY = "movements-split";
const loadSplit = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const saveSplit = (v) => { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* not kept */ } };

export async function openMovements(ctx) {
  const d = ctx.dialog;
  const [, , from, to] = presets()[0];
  const f = { from, to, split: loadSplit() };
  let r = null;
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Loading…</p></div></div>';
  if (!d.open) d.showModal();

  const load = async () => {
    try {
      r = await get(`/api/movements?${new URLSearchParams({ from: f.from, to: f.to })}`);
      draw();
    } catch (e) {
      const b = d.querySelector(".body");
      if (b) b.innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    }
  };

  const headCell = (c) => f.split
    ? `<td class="num">${c.own || ""}</td><td class="num">${c.agisted || ""}</td>`
    : `<td class="num"><b>${c.head}</b></td>`;
  const evidenceHtml = (c) => {
    if (!c.evidence.length) return '<span class="muted">none found</span>';
    const total = c.evidence.reduce((t, e) => t + e.head, 0);
    const list = c.evidence.map((e) => `${e.head} ${escapeHtml(e.source)}${e.place ? ` (${escapeHtml(e.place)})` : ""}${e.date !== c.date ? ` <span class="muted">${escapeHtml(day(e.date))}</span>` : ""}`).join("<br>");
    const diff = c.head - total;
    return `${list}${c.evidence.length > 1 ? `<br><b>${total}</b> in all` : ""}${diff !== 0 ? `<div class="${Math.abs(diff) > 2 ? "bad" : "muted"} tiny">records ${diff > 0 ? `${diff} more` : `${-diff} fewer`} than the outside records</div>` : '<div class="good tiny">matches</div>'}`;
  };

  const draw = () => {
    const t = r.totals;
    const on = t.on.own + t.on.agisted, off = t.off.own + t.off.agisted, dead = t.deaths.own + t.deaths.agisted;
    const both = (x) => f.split ? `${x.own + x.agisted} <span class="muted small">(own ${x.own}, agisted ${x.agisted})</span>` : `${x.own + x.agisted}`;
    const sel = presets().find(([, , a, b]) => a === f.from && b === f.to)?.[0] ?? "";
    d.innerHTML = `
      <div class="dlg wide report">
        <header>
          <h2>Cattle on and off</h2>
          <div class="row2 no-print">
            <div class="f"><label for="mvFrom">Start</label><input type="date" id="mvFrom" value="${f.from}"></div>
            <div class="f"><label for="mvTo">Finish</label><input type="date" id="mvTo" value="${f.to}"></div>
          </div>
          <div class="row2 no-print">
            <div class="f"><label for="mvPreset">Quick pick</label><select id="mvPreset"><option value="">Choose…</option>
              ${presets().map(([k, n]) => `<option value="${k}"${k === sel ? " selected" : ""}>${n}</option>`).join("")}</select></div>
            <div class="f"><label class="radio"><input type="checkbox" id="mvSplit"${f.split ? " checked" : ""}> Show own and agisted cattle separately</label></div>
          </div>
        </header>
        <div class="body">
          <p class="small">${day(r.from)} to ${day(r.to)}: on hand at the start <b>${r.on_hand.start}</b>,
            in <b>${both(t.on)}</b>, out <b>${both(t.off)}</b>, deaths <b>${both(t.deaths)}</b>${t.recounts ? `, recounts <b>${signed(t.recounts)}</b>` : ""}${t.other ? `, ${r.other.every((x) => x.what === "On hand when records began") ? "on hand when records began" : "other changes"} <b>${signed(t.other)}</b>` : ""},
            on hand at the finish <b>${r.on_hand.end}</b>.
            ${r.on_hand.start + on - off - dead + t.recounts + t.other !== r.on_hand.end ? '<span class="bad">These don\'t add up — see the head count register.</span>' : ""}</p>

          <h3>Consignments</h3>
          <table class="list movements"><thead><tr><th>Date</th><th>In / out</th>${f.split ? '<th class="num">Own</th><th class="num">Agisted</th>' : '<th class="num">Head</th>'}<th>Mobs</th><th>NLIS and scales records</th></tr></thead><tbody>
            ${r.consignments.map((c) => `<tr>
              <td>${escapeHtml(day(c.date))}</td>
              <td>${c.direction === "on" ? "In" : "Out"}</td>
              ${headCell(c)}
              <td class="small">${c.lines.map((l) => `${l.head} ${escapeHtml(l.mob)}${f.split && l.owner ? ` <span class="muted">(${escapeHtml(l.owner)})</span>` : ""}
                <span class="muted">· ${escapeHtml(l.what.toLowerCase())}${l.notes.filter((n) => !n.startsWith("AgriWebb:")).map((n) => ` · ${escapeHtml(n)}`).join("")}</span>`).join("<br>")}</td>
              <td class="small">${evidenceHtml(c)}</td>
            </tr>`).join("") || `<tr><td colspan="${f.split ? 6 : 5}" class="muted">No cattle came on or went off in that time.</td></tr>`}
          </tbody></table>

          ${r.unmatched.length ? `<h3>In NLIS or scales records but not in the books</h3>
            <table class="list"><thead><tr><th>Date</th><th>In / out</th><th class="num">Head</th><th>Record</th></tr></thead><tbody>
            ${r.unmatched.map((e) => `<tr><td>${escapeHtml(day(e.date))}</td><td>${e.direction === "on" ? "In" : "Out"}</td><td class="num">${e.head}</td>
              <td class="small">${escapeHtml(e.source)}${e.place ? ` (${escapeHtml(e.place)})` : ""}</td></tr>`).join("")}
            </tbody></table>` : ""}

          ${r.deaths.length ? `<h3>Deaths</h3><table class="list"><thead><tr><th>Date</th><th>Mob</th><th class="num">Head</th><th>Notes</th></tr></thead><tbody>
            ${r.deaths.map((x) => `<tr><td>${escapeHtml(day(x.date))}</td><td>${escapeHtml(x.mob)}${f.split && x.owner ? ` <span class="muted">(${escapeHtml(x.owner)})</span>` : ""}</td>
              <td class="num">${x.head}</td><td class="small">${x.notes.filter((n) => !n.startsWith("AgriWebb:")).map(escapeHtml).join(" · ") || '<span class="muted">—</span>'}</td></tr>`).join("")}
            </tbody></table>` : ""}

          ${r.recounts.length ? `<h3>Recounts</h3><table class="list"><thead><tr><th>Date</th><th>Mob</th><th class="num">Change</th><th class="num">Mob</th><th>Notes</th></tr></thead><tbody>
            ${r.recounts.map((x) => `<tr><td>${escapeHtml(day(x.date))}</td><td>${escapeHtml(x.mob)}${f.split && x.owner ? ` <span class="muted">(${escapeHtml(x.owner)})</span>` : ""}</td>
              <td class="num">${signed(x.change)}</td><td class="num">${x.before} → ${x.after}</td>
              <td class="small">${x.notes.filter((n) => !n.startsWith("AgriWebb:")).map(escapeHtml).join(" · ") || '<span class="muted">—</span>'}</td></tr>`).join("")}
            </tbody></table>` : ""}

          ${r.other.length ? `<h3>Other changes to the total</h3><table class="list"><thead><tr><th>Date</th><th>Mob</th><th>What</th><th class="num">Change</th><th>Notes</th></tr></thead><tbody>
            ${r.other.map((x) => `<tr><td>${escapeHtml(day(x.date))}</td><td>${escapeHtml(x.mob)}${f.split && x.owner ? ` <span class="muted">(${escapeHtml(x.owner)})</span>` : ""}</td>
              <td>${escapeHtml(x.what)}</td><td class="num">${signed(x.change)}</td>
              <td class="small">${x.notes.filter((n) => !n.startsWith("AgriWebb:")).map(escapeHtml).join(" · ") || '<span class="muted">—</span>'}</td></tr>`).join("")}
            </tbody></table>` : ""}

          <p class="muted tiny">Consignments are the purchases, sales and transfers on or off farm in the head count register, one row per day each way. Beside each are NLIS move-offs and move-ons, and cattle last seen on the scales before they went, within ${3} days of it. NLIS move-ons only come from the "currently on PIC" report, so cattle bought and since sold may not show. Head on hand includes agisted cattle.</p>
        </div>
        <footer class="btns"><button class="btn" id="mvClose">Close</button><button class="btn" id="mvPrint">Print</button><button class="btn primary" id="mvCsv">Export CSV</button></footer>
      </div>`;

    const reload = () => {
      const a = d.querySelector("#mvFrom").value, b = d.querySelector("#mvTo").value;
      if (a && b) { f.from = a; f.to = b; load(); }
    };
    d.querySelector("#mvFrom").onchange = reload;
    d.querySelector("#mvTo").onchange = reload;
    d.querySelector("#mvPreset").onchange = (e) => {
      const p = presets().find(([k]) => k === e.target.value);
      if (p) { f.from = p[2]; f.to = p[3]; load(); }
    };
    d.querySelector("#mvSplit").onchange = (e) => { f.split = e.target.checked; saveSplit(f.split); draw(); };
    d.querySelector("#mvClose").onclick = () => d.close();
    d.querySelector("#mvPrint").onclick = () => {
      document.body.classList.add("printing-report");
      window.print();
      setTimeout(() => document.body.classList.remove("printing-report"), 500);
    };
    d.querySelector("#mvCsv").onclick = () => {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const head = ["Date", "In/out", ...(f.split ? ["Own head", "Agisted head"] : ["Head"]), "Mob", "Owner", "Mob head", "What", "Notes", "NLIS and scales records", "Outside records head"];
      const lines = [head.map(q).join(",")];
      for (const c of r.consignments) {
        const ev = c.evidence.map((e) => `${e.date} ${e.head} ${e.source}${e.place ? ` (${e.place})` : ""}`).join(" | ");
        const evN = c.evidence.reduce((t, e) => t + e.head, 0);
        c.lines.forEach((l, i) => lines.push([c.date, c.direction === "on" ? "In" : "Out",
          ...(i === 0 ? (f.split ? [c.own, c.agisted] : [c.head]) : (f.split ? ["", ""] : [""])),
          l.mob, l.owner, l.head, l.what, l.notes.join(" | "), i === 0 ? ev : "", i === 0 && c.evidence.length ? evN : ""].map(q).join(",")));
      }
      for (const x of r.deaths) lines.push([x.date, "Death", ...(f.split ? [x.owner ? "" : x.head, x.owner ? x.head : ""] : [x.head]), x.mob, x.owner, x.head, "Death", x.notes.join(" | "), "", ""].map(q).join(","));
      for (const x of r.other) lines.push([x.date, x.what, ...(f.split ? ["", ""] : [""]), x.mob, x.owner, x.change, x.what, x.notes.join(" | "), "", ""].map(q).join(","));
      for (const x of r.recounts) lines.push([x.date, "Recount", ...(f.split ? ["", ""] : [""]), x.mob, x.owner, x.change, `Recount ${x.before} → ${x.after}`, x.notes.join(" | "), "", ""].map(q).join(","));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
      a.download = `Cattle on and off ${f.from} to ${f.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  };
  load();
}
