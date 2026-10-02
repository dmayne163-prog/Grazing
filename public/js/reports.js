/**
 * Reports: filter the animals, list them with weights and carcass weights,
 * total them, and export or print — the consignment list for the works in a
 * few clicks, against APS's seven-step wizard.
 *
 * Rules are ANDed; each allows several values (OR within it). Setups can be
 * saved by name and run again. The CSV matches the layout the works already
 * get from APS: Tag, Electronic ID, Last Weight, Carcass Weight, Sex, with
 * count, average, total, minimum and maximum underneath.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const eidText = (e) => (e ? e.replace(/^(\d{3})(\d+)$/, "$1 $2") : "");

const COLUMNS = [
  ["tag", "Tag"], ["eid", "Electronic ID"], ["nlis", "NLIS"], ["sex", "Sex"], ["mob", "Mob"], ["status", "Status"],
  ["weight_kg", "Last Weight"], ["weighed", "Weighed"], ["carcass_kg", "Carcass Weight"],
];
const DEFAULT = { title: "", rules: [], weights_from: "latest", dressing_pct: 52, sort: "weight", columns: ["tag", "eid", "weight_kg", "carcass_kg", "sex"] };
const RULES = [["session", "Seen in a session"], ["field", "Data field"], ["sex", "Sex"], ["mob", "Mob"], ["status", "Status"]];
const STATUSES = [["alive", "On hand"], ["sold", "Sold"], ["dead", "Dead"], ["gone", "Gone"]];
const SEXES = [["female", "Female"], ["steer", "Steer"], ["male", "Male"], ["stag", "Stag"], ["unknown", "Not recorded"]];

export async function openReports(ctx) {
  const d = ctx.dialog;
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Loading…</p></div></div>';
  if (!d.open) d.showModal();
  let opts;
  try {
    opts = await get("/api/reports/options");
  } catch (e) {
    d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    return;
  }
  let spec = structuredClone(DEFAULT);
  let result = null;

  const ruleHtml = (r, i) => {
    const head = `<div class="rulehead"><b>${escapeHtml(RULES.find(([k]) => k === r.kind)[1])}</b><button class="linkbtn danger-link" data-del="${i}">Remove</button></div>`;
    switch (r.kind) {
      case "session":
        return `${head}<div class="radios"><label class="radio"><input type="radio" name="seen${i}" data-seen="${i}" value="1"${r.seen ? " checked" : ""}> was seen in</label>
          <label class="radio"><input type="radio" name="seen${i}" data-seen="${i}" value="0"${!r.seen ? " checked" : ""}> was not seen in</label></div>
          <div class="checklist">${opts.sessions.map((s) => `<label><input type="checkbox" data-sess="${i}" value="${s.id}"${r.session_ids.includes(s.id) ? " checked" : ""}>
            <span>${escapeHtml(day(s.date))}</span><span>${escapeHtml(s.name)}</span><span class="muted">${s.animal_count} hd${s.mob ? ` · ${escapeHtml(s.mob)}` : ""}</span></label>`).join("") || '<p class="muted small">No sessions imported yet.</p>'}</div>`;
      case "field": {
        const names = Object.keys(opts.fields);
        const values = opts.fields[r.field] || [];
        return `${head}${names.length ? `<div class="row2"><select data-fname="${i}"><option value="">Choose a field…</option>${names.map((n) => `<option${n === r.field ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select>
          <select data-fsess="${i}"><option value="">its latest value</option>${opts.sessions.map((s) => `<option value="${s.id}"${s.id === r.session_id ? " selected" : ""}>in ${escapeHtml(day(s.date))} ${escapeHtml(s.name)}</option>`).join("")}</select></div>
          ${r.field ? `<div class="checklist short">${values.map((v) => `<label><input type="checkbox" data-fval="${i}" value="${escapeHtml(v)}"${r.values.includes(v) ? " checked" : ""}> ${escapeHtml(v)}</label>`).join("")}</div>
          <p class="muted tiny">Tick the values that count, or none for any value.</p>` : ""}`
          : '<p class="muted small">No data fields yet: they come in with sessions from the scales.</p>'}`;
      }
      case "sex":
        return `${head}<div class="radios"><label class="radio"><input type="radio" name="sexnot${i}" data-sexnot="${i}" value="0"${!r.not ? " checked" : ""}> is</label>
          <label class="radio"><input type="radio" name="sexnot${i}" data-sexnot="${i}" value="1"${r.not ? " checked" : ""}> is not</label></div>
          <div class="chips">${SEXES.map(([k, t]) => `<label class="radio"><input type="checkbox" data-sex="${i}" value="${k}"${r.values.includes(k) ? " checked" : ""}> ${t}</label>`).join("")}</div>`;
      case "mob":
        return `${head}<div class="checklist short">${opts.mobs.map((m) => `<label><input type="checkbox" data-mob="${i}" value="${m.id}"${r.mob_ids.includes(m.id) ? " checked" : ""}> ${escapeHtml(m.name)}</label>`).join("")}</div>`;
      case "status":
        return `${head}<div class="chips">${STATUSES.map(([k, t]) => `<label class="radio"><input type="checkbox" data-status="${i}" value="${k}"${r.values.includes(k) ? " checked" : ""}> ${t}</label>`).join("")}</div>`;
    }
    return "";
  };

  const fmt = (r, k) => k === "eid" ? eidText(r.eid) : k === "weighed" ? day(r.weighed) : r[k] ?? "";
  const statsRow = (label, key) => {
    const ws = result.stats.weight, cs = result.stats.carcass;
    return `<tr class="stats"><td>${label}</td>${spec.columns.map((c) => `<td class="num">${
      c === "weight_kg" ? (ws[key] ?? "") : c === "carcass_kg" ? (cs[key] ?? "") : key === "count" ? result.rows.length : ""}</td>`).join("")}</tr>`;
  };

  const draw = () => {
    d.innerHTML = `
      <div class="dlg wide report">
        <header class="no-print">
          <h2>Reports</h2>
          <div class="row2">
            <select id="rpPreset"><option value="">Saved reports…</option>${opts.presets.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}</select>
            <span></span>
          </div>
        </header>
        <div class="body">
          <div class="no-print">
            <div class="f"><label for="rpTitle">Title</label><input id="rpTitle" value="${escapeHtml(spec.title)}" placeholder="e.g. Hewitt Foods consignment"></div>
            <h3>Animals that…</h3>
            ${spec.rules.map((r, i) => `<div class="rule">${ruleHtml(r, i)}</div>`).join("") || '<p class="muted small">Every animal with a record. Add a rule to narrow it down.</p>'}
            <div class="row2"><select id="rpAdd"><option value="">Add a rule…</option>${RULES.map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select><span></span></div>
            <h3>Report</h3>
            <div class="row3">
              <div class="f"><label for="rpWeights">Weights</label><select id="rpWeights"><option value="latest">Each animal's latest</option>${opts.sessions.map((s) => `<option value="${s.id}"${s.id === spec.weights_from ? " selected" : ""}>From ${escapeHtml(day(s.date))} ${escapeHtml(s.name)}</option>`).join("")}</select></div>
              <div class="f"><label for="rpPct">Dressing %</label><input id="rpPct" type="number" min="1" max="100" step="0.5" value="${spec.dressing_pct}"></div>
              <div class="f"><label for="rpSort">Sort</label><select id="rpSort"><option value="weight"${spec.sort === "weight" ? " selected" : ""}>Lightest first</option><option value="tag"${spec.sort === "tag" ? " selected" : ""}>By tag</option></select></div>
            </div>
            <div class="chips">${COLUMNS.map(([k, t]) => `<label class="radio"><input type="checkbox" data-col="${k}"${spec.columns.includes(k) ? " checked" : ""}> ${t}</label>`).join("")}</div>
          </div>
          <div id="rpOut" class="gap-top">${result ? outHtml() : '<p class="muted small">Running…</p>'}</div>
        </div>
        <footer class="no-print">
          <button class="btn" id="rpClose">Close</button>
          <span class="grow"></span>
          ${ctx.canEdit ? '<button class="btn" id="rpSave">Save as…</button>' : ""}
          <button class="btn" id="rpPrint">Print</button>
          <button class="btn primary" id="rpCsv">Export CSV</button>
        </footer>
      </div>`;
    bind();
  };

  const outHtml = () => {
    const s = result.stats;
    return `
      <div class="print-only"><h2>${escapeHtml(spec.title || "Animal report")}</h2><p class="small">${escapeHtml(day(new Date().toISOString().slice(0, 10)))} · dressing ${spec.dressing_pct}%</p></div>
      <p class="small no-print"><b>${s.head}</b> animal${s.head === 1 ? "" : "s"}${s.weight.average ? ` · average <b>${s.weight.average} kg</b> live, <b>${s.carcass.average} kg</b> carcass at ${spec.dressing_pct}%` : ""}${s.no_weight ? ` · ${s.no_weight} with no weight` : ""}</p>
      <table class="list report-table">
        <thead><tr><th></th>${spec.columns.map((c) => `<th class="${["weight_kg", "carcass_kg"].includes(c) ? "num" : ""}">${COLUMNS.find(([k]) => k === c)[1]}</th>`).join("")}</tr></thead>
        <tbody>${result.rows.map((r, i) => `<tr><td class="muted tiny">${i + 1}</td>${spec.columns.map((c) => `<td class="${["weight_kg", "carcass_kg"].includes(c) ? "num" : ""}">${escapeHtml(String(fmt(r, c)))}</td>`).join("")}</tr>`).join("")}</tbody>
        <tfoot>${result.rows.length ? ["count", "average", "total", "min", "max"].map((k) => statsRow({ count: "Count", average: "Average", total: "Total", min: "Minimum", max: "Maximum" }[k], k)).join("") : ""}</tfoot>
      </table>`;
  };

  let runSeq = 0;
  const run = async () => {
    const mine = ++runSeq;
    try {
      const r = await send("POST", "/api/reports/run", {
        rules: spec.rules.filter(ready), weights_from: spec.weights_from, dressing_pct: spec.dressing_pct, sort: spec.sort,
      });
      if (mine !== runSeq) return;
      result = r;
      const out = d.querySelector("#rpOut");
      if (out) out.innerHTML = outHtml();
    } catch (e) {
      const out = d.querySelector("#rpOut");
      if (out) out.innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    }
  };
  // A rule still being set up doesn't filter yet.
  const ready = (r) => r.kind === "session" ? r.session_ids.length > 0
    : r.kind === "field" ? !!r.field
    : r.kind === "sex" ? r.values.length > 0
    : r.kind === "mob" ? r.mob_ids.length > 0
    : r.kind === "status" ? r.values.length > 0 : false;

  const checked = (sel) => [...d.querySelectorAll(sel)].filter((x) => x.checked).map((x) => x.value);
  const bind = () => {
    d.querySelector("#rpClose").onclick = () => d.close();
    d.querySelector("#rpTitle").oninput = (e) => { spec.title = e.target.value; };
    d.querySelector("#rpAdd").onchange = (e) => {
      const k = e.target.value;
      if (!k) return;
      spec.rules.push(k === "session" ? { kind: k, session_ids: [], seen: true } : k === "field" ? { kind: k, field: "", values: [], session_id: null }
        : k === "sex" ? { kind: k, values: [], not: false } : k === "mob" ? { kind: k, mob_ids: [] } : { kind: k, values: ["alive"] });
      draw();
    };
    d.querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => { spec.rules.splice(Number(b.dataset.del), 1); draw(); run(); }; });
    const each = (attr, fn) => d.querySelectorAll(`[data-${attr}]`).forEach((el) => {
      el.onchange = () => { fn(spec.rules[Number(el.dataset[attr.replace(/-./g, (x) => x[1].toUpperCase())])], el); run(); };
    });
    each("seen", (r, el) => { r.seen = el.value === "1"; });
    each("sess", (r, el) => { r.session_ids = checked(`[data-sess="${el.dataset.sess}"]`).map(Number); });
    each("fname", (r, el) => { r.field = el.value; r.values = []; draw(); });
    each("fsess", (r, el) => { r.session_id = el.value ? Number(el.value) : null; });
    each("fval", (r, el) => { r.values = checked(`[data-fval="${el.dataset.fval}"]`); });
    each("sexnot", (r, el) => { r.not = el.value === "1"; });
    each("sex", (r, el) => { r.values = checked(`[data-sex="${el.dataset.sex}"]`); });
    each("mob", (r, el) => { r.mob_ids = checked(`[data-mob="${el.dataset.mob}"]`).map(Number); });
    each("status", (r, el) => { r.values = checked(`[data-status="${el.dataset.status}"]`); });
    d.querySelector("#rpWeights").onchange = (e) => { spec.weights_from = e.target.value === "latest" ? "latest" : Number(e.target.value); run(); };
    d.querySelector("#rpPct").oninput = (e) => { const v = Number(e.target.value); if (v > 0 && v <= 100) { spec.dressing_pct = v; run(); } };
    d.querySelector("#rpSort").onchange = (e) => { spec.sort = e.target.value; run(); };
    d.querySelectorAll("[data-col]").forEach((el) => {
      el.onchange = () => {
        spec.columns = COLUMNS.map(([k]) => k).filter((k) => d.querySelector(`[data-col="${k}"]`).checked);
        if (result) d.querySelector("#rpOut").innerHTML = outHtml();
      };
    });
    d.querySelector("#rpPreset").onchange = (e) => {
      const p = opts.presets.find((x) => String(x.id) === e.target.value);
      if (!p) return;
      spec = { ...structuredClone(DEFAULT), ...structuredClone(p.spec), title: p.spec.title || p.name };
      result = null;
      draw();
      run();
    };
    const save = d.querySelector("#rpSave");
    if (save) save.onclick = async () => {
      const name = prompt("Save this report as", spec.title || "");
      if (!name) return;
      try {
        await send("PUT", "/api/reports/presets", { name, spec });
        opts = await get("/api/reports/options");
        ctx.toast(`Saved "${name}"`);
        draw();
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
    d.querySelector("#rpPrint").onclick = () => {
      document.body.classList.add("printing-report");
      window.print();
      setTimeout(() => document.body.classList.remove("printing-report"), 500);
    };
    d.querySelector("#rpCsv").onclick = () => {
      if (!result) return;
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const head = ["Statistics", ...spec.columns.map((c) => COLUMNS.find(([k]) => k === c)[1])];
      const lines = [head.map(q).join(",")];
      for (const r of result.rows) lines.push(["", ...spec.columns.map((c) => fmt(r, c))].map(q).join(","));
      const st = (label, key) => [label, ...spec.columns.map((c) => c === "weight_kg" ? result.stats.weight[key] : c === "carcass_kg" ? result.stats.carcass[key] : key === "count" ? result.rows.length : "")].map(q).join(",");
      lines.push(st("Count:", "count"), st("Average:", "average"), st("Total:", "total"), st("Minimum:", "min"), st("Maximum:", "max"));
      const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(spec.title || "Animal report").replace(/[\\/:*?"<>|]/g, "")} ${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  };

  draw();
  run();
}
