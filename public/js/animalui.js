/**
 * Individual animals in the interface: the animal page, its actions (weight,
 * note, death), the list of animals on a mob's page, and search results.
 *
 * Uses the same `ctx` as stockui.js, plus ctx.selectAnimal(id).
 */
import { get, send } from "./api.js";
import { openReports } from "./reports.js";
import { escapeHtml } from "./map.js";
import { bindWhen, readWhen, showError, undoable, whenHtml } from "./stockui.js";

const $ = (sel, root) => root.querySelector(sel);
const nf0 = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 });
const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—");
const span = (from, to) => `${day(from)} – ${to ? day(to) : "now"}`;

/** "982123798726941" → "982 123798726941", the way it is printed on the tag. */
export const eidText = (eid) => (eid && eid.length === 15 ? `${eid.slice(0, 3)} ${eid.slice(3)}` : eid || "");
const label = (a) => a.tag || eidText(a.eid) || a.nlis || `#${a.id}`;
const gain = (g) => (g == null ? "" : `${g > 0 ? "+" : ""}${nf1.format(g)} kg/day`);
const age = (birth) => {
  if (!birth) return "";
  const months = Math.floor((Date.now() - Date.parse(`${birth}T00:00:00`)) / (30.44 * 86_400_000));
  return months < 24 ? `${months} months` : `${Math.floor(months / 12)} yr ${months % 12} mo`;
};
const SEX = { female: "Female", male: "Bull / male", steer: "Steer", stag: "Stag" };

/* --------------------------------- page ------------------------------------ */

export async function renderAnimal(ctx, id, root) {
  root.innerHTML = '<p class="muted small">Loading…</p>';
  let v;
  try {
    v = await get(`/api/animals/${id}`);
  } catch (e) {
    root.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
    return;
  }
  const a = v.animal;
  const alive = v.status === "alive";
  const last = v.weights[v.weights.length - 1];
  const here = v.paddocks.find((p) => !p.to);
  const sale = v.events.find((e) => e.kind === "sale");

  root.innerHTML = `
    <button class="linkbtn back" id="back">← ${v.mob_id ? escapeHtml(v.mob_name) : "Back"}</button>
    <h2>${escapeHtml(label(a))}</h2>
    <p class="animalline">${a.sex
      ? `<b>${escapeHtml(SEX[a.sex])}</b>`
      : ctx.canEdit
        ? `<span class="muted">Sex not recorded:</span> ${["female", "steer", "male", "stag"].map((x) => `<button class="chipbtn" data-sex="${x}">${SEX[x]}</button>`).join("")}`
        : '<span class="muted">Sex not recorded</span>'}${[a.breed, a.birth_date ? age(a.birth_date) : null].filter(Boolean).map((t) => ` · ${escapeHtml(t)}`).join("")}</p>
    <p class="sub">${[a.eid ? `EID ${escapeHtml(eidText(a.eid))}` : null, a.nlis ? `NLIS ${escapeHtml(a.nlis)}` : null].filter(Boolean).join(" · ") || "No EID recorded"}</p>

    <div class="statuscard">
      <div class="big">${alive ? "" : `<span class="gatestate">${{ dead: "Dead", sold: "Sold", gone: "Off the books" }[v.status]} ${day(v.status_date)}${v.status === "sold" && sale?.data?.destination ? ` to ${escapeHtml(sale.data.destination)}` : ""}</span> `}
        ${v.mob_id ? `<button class="linkbtn" id="aMob">${escapeHtml(v.mob_name)}</button>` : '<span class="muted">Not in a mob</span>'}
        ${here && alive ? ` · ${escapeHtml(here.paddocks.join(" + "))}` : ""}</div>
      <div class="muted small">${last ? `${nf0.format(last.weight_kg)} kg on ${day(last.date)}${last.gain_per_day != null ? ` · ${gain(last.gain_per_day)} since the weighing before` : ""}` : "Not weighed"}</div>
      ${ctx.canEdit && alive ? `<div class="btns">
        <button class="btn primary" id="aWeigh">Record weight…</button>
        <button class="btn" id="aNote">Add note…</button>
        <button class="btn" id="aSale">Record sale…</button>
        <button class="btn danger" id="aDeath">Record death…</button>
      </div>` : ""}
    </div>

    <h3>Details</h3>
    <dl class="facts">
      <dt>Sex</dt><dd>${escapeHtml(SEX[a.sex] || "—")}</dd>
      <dt>Breed</dt><dd>${escapeHtml(a.breed || "—")}</dd>
      <dt>Born</dt><dd>${a.birth_date ? `${day(a.birth_date)} <span class="muted">(${age(a.birth_date)})</span>` : "—"}</dd>
      <dt>Tag</dt><dd>${escapeHtml(a.tag || "—")}</dd>
      <dt>EID</dt><dd>${escapeHtml(eidText(a.eid) || "—")}</dd>
      <dt>NLIS</dt><dd>${escapeHtml(a.nlis || "—")}</dd>
      <dt>Origin</dt><dd>${escapeHtml(a.origin || "—")}</dd>
      ${sale?.data?.price != null ? `<dt>Sold for</dt><dd>${sale.data.price_unit === "c/kg" ? `${nf1.format(sale.data.price)} c/kg` : `${nf0.format(sale.data.price)} /hd`}</dd>` : ""}
    </dl>
    ${ctx.canEdit ? `<details><summary class="small">Edit details</summary>
      <div class="row2">
        <div class="f"><label for="dTag">Tag</label><input id="dTag" value="${escapeHtml(a.tag || "")}" autocomplete="off"></div>
        <div class="f"><label for="dSex">Sex</label><select id="dSex">${["", "female", "steer", "male", "stag"].map((x) => `<option value="${x}"${x === (a.sex || "") ? " selected" : ""}>${x ? SEX[x] : "unknown"}</option>`).join("")}</select></div>
      </div>
      <div class="row2">
        <div class="f"><label for="dBreed">Breed</label><input id="dBreed" value="${escapeHtml(a.breed || "")}" autocomplete="off"></div>
        <div class="f"><label for="dBirth">Born</label><input id="dBirth" type="date" value="${a.birth_date || ""}"></div>
      </div>
      <div class="row2">
        <div class="f"><label for="dEid">EID</label><input id="dEid" value="${escapeHtml(eidText(a.eid))}" inputmode="numeric" autocomplete="off"></div>
        <div class="f"><label for="dNlis">NLIS</label><input id="dNlis" value="${escapeHtml(a.nlis || "")}" autocomplete="off"></div>
      </div>
      <div class="f"><label for="dOrigin">Origin</label><input id="dOrigin" value="${escapeHtml(a.origin || "")}" placeholder="e.g. bred, or bought from Penjobe" autocomplete="off"></div>
      <div class="btns"><button class="btn" id="dSave">Save details</button></div>
    </details>` : ""}

    <h3>Weights</h3>
    ${v.weights.length ? `<table class="list"><thead><tr><th>Date</th><th class="num">Weight</th><th class="num">Gain</th><th>From</th></tr></thead><tbody>
      ${[...v.weights].reverse().map((w) => `<tr><td>${day(w.date)}</td><td class="num">${nf1.format(w.weight_kg)} kg</td>
        <td class="num">${escapeHtml(gain(w.gain_per_day))}</td><td class="muted small">${escapeHtml(w.session || (w.source === "app" ? "entered" : ""))}</td></tr>`).join("")}
    </tbody></table>` : '<p class="muted small">No weights yet.</p>'}

    <h3>Paddocks</h3>
    ${v.paddocks.length ? `<ul class="history">${v.paddocks.map((p) => `
      <li><span class="when">${span(p.from, p.to)}</span><span class="grow">${escapeHtml(p.paddocks.join(" + "))}<br><span class="muted tiny">with ${escapeHtml(p.mob_name || "")}</span></span></li>`).join("")}</ul>`
    : '<p class="muted small">Not placed in a mob yet, so no paddock history.</p>'}

    <h3>History</h3>
    <ul class="history">${(() => { const seen = new Set(); return v.events.map((e) => {
      const what = {
        join: `Joined ${escapeHtml(e.mob_name || "a mob")}`,
        leave: `Left ${escapeHtml(e.mob_name || "a mob")}`,
        weigh: `Weighed · ${nf1.format(e.weight_kg)} kg`,
        score: `Condition score ${e.score}`,
        note: "Note",
        death: "Died",
        sale: `Sold${e.data?.destination ? ` to ${escapeHtml(e.data.destination)}` : ""}`,
        gone: `Off the books${e.data?.destination ? ` · probably to ${escapeHtml(e.data.destination)}` : ""}`,
        treatment: "Processed",
      }[e.kind] || escapeHtml(e.kind);
      // One undo per action: a sale with its sale weight is one batch.
      const undo = ctx.canEdit && e.batch && e.source === "app" && !seen.has(e.batch);
      if (e.batch) seen.add(e.batch);
      return `<li><span class="when">${day(e.date)}${e.time ? `<br><span class="muted tiny">${escapeHtml(e.time)}</span>` : ""}</span>
        <span class="grow">${what}${e.text ? `<br><span class="muted tiny">${escapeHtml(e.text)}</span>` : ""}${e.source.startsWith("session:") || e.source === "tsi" ? '<br><span class="muted tiny">from the scales</span>' : ""}</span>
        ${undo ? `<button class="linkbtn danger-link" data-undo="${e.batch}">Undo</button>` : ""}</li>`;
    }).join(""); })() || '<li class="muted">Nothing recorded.</li>'}</ul>`;

  $("#back", root).onclick = () => (v.mob_id ? ctx.selectMob(v.mob_id) : ctx.backToMobs());
  const mobBtn = $("#aMob", root);
  if (mobBtn) mobBtn.onclick = () => ctx.selectMob(v.mob_id);
  // ctx.refresh re-renders the panel, which redraws this page with the change.
  const done = async (message, batch) => { await ctx.refresh(); undoable(ctx, message, batch); };

  $("#aWeigh", root)?.addEventListener("click", () => formDialog(ctx, {
    title: `Weigh ${label(a)}`,
    fields: `<div class="f"><label for="fKg">Weight (kg)</label><input id="fKg" type="number" min="1" step="0.5" inputmode="decimal"></div>
      <div class="f"><label for="fNote">Note</label><input id="fNote" placeholder="optional" autocomplete="off"></div>`,
    go: "Save weight",
    submit: async (d) => {
      const kg = Number($("#fKg", d).value);
      if (!kg) throw new Error("Enter the weight in kg");
      const r = await send("POST", `/api/animals/${id}/weigh`, { weight_kg: kg, note: $("#fNote", d).value, ...readWhen(d, "f") });
      await done(`${label(a)}: ${nf1.format(kg)} kg`, r.batch);
    },
  }));
  $("#aNote", root)?.addEventListener("click", () => formDialog(ctx, {
    title: `Note for ${label(a)}`,
    fields: `<div class="f"><label for="fText">Note</label><textarea id="fText"></textarea></div>`,
    go: "Save note",
    submit: async (d) => {
      const r = await send("POST", `/api/animals/${id}/note`, { text: $("#fText", d).value, ...readWhen(d, "f") });
      await done("Note saved", r.batch);
    },
  }));
  root.querySelectorAll("[data-sex]").forEach((b) => {
    b.onclick = async () => {
      try {
        await send("PATCH", `/api/animals/${id}`, { sex: b.dataset.sex });
        await ctx.refresh();
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
  });
  $("#dSave", root)?.addEventListener("click", async () => {
    try {
      await send("PATCH", `/api/animals/${id}`, {
        tag: $("#dTag", root).value, sex: $("#dSex", root).value, breed: $("#dBreed", root).value,
        birth_date: $("#dBirth", root).value, eid: $("#dEid", root).value, nlis: $("#dNlis", root).value,
        origin: $("#dOrigin", root).value,
      });
      await ctx.refresh();
      ctx.toast("Details saved");
    } catch (e) {
      ctx.toast(e.message, { error: true });
    }
  });
  $("#aSale", root)?.addEventListener("click", () => formDialog(ctx, {
    title: `Record the sale of ${label(a)}`,
    fields: `<div class="f"><label for="fTo">Sold to</label><input id="fTo" placeholder="buyer, saleyard or abattoir" autocomplete="off"></div>
      <div class="row2">
        <div class="f"><label for="fKg">Sale weight (kg)</label><input id="fKg" type="number" min="1" step="0.5" inputmode="decimal" placeholder="optional"></div>
        <div class="f"><label for="fPrice">Price</label>
          <div class="pricebox"><input id="fPrice" type="number" min="0" step="0.01" inputmode="decimal" placeholder="optional">
          <select id="fUnit"><option value="c/kg">c/kg</option><option value="$/hd">$/hd</option></select></div></div>
      </div>
      <div class="f"><label for="fNote">Note</label><input id="fNote" placeholder="optional" autocomplete="off"></div>
      ${v.mob_id ? `<label class="radio"><input type="checkbox" id="fMob" checked> Take 1 hd off ${escapeHtml(v.mob_name)}</label>
      <p class="muted small">Untick if the mob's count already allows for this sale.</p>` : ""}`,
    go: "Record sale",
    submit: async (d) => {
      const r = await send("POST", `/api/animals/${id}/sale`, {
        destination: $("#fTo", d).value, weight_kg: $("#fKg", d).value || null,
        price: $("#fPrice", d).value || null, price_unit: $("#fUnit", d).value, note: $("#fNote", d).value,
        also_mob: $("#fMob", d)?.checked ?? false, ...readWhen(d, "f"),
      });
      await done(`${label(a)} recorded as sold`, r.batch);
    },
  }));
  $("#aDeath", root)?.addEventListener("click", () => formDialog(ctx, {
    title: `Record the death of ${label(a)}`,
    fields: `<div class="f"><label for="fCause">Cause</label><input id="fCause" placeholder="if known" autocomplete="off"></div>
      ${v.mob_id ? `<label class="radio"><input type="checkbox" id="fMob" checked> Take 1 hd off ${escapeHtml(v.mob_name)}</label>
      <p class="muted small">Untick if the mob's count already allows for this death — for example it was recorded in AgriWebb before this animal had a record here.</p>` : ""}`,
    go: "Record death",
    submit: async (d) => {
      const r = await send("POST", `/api/animals/${id}/death`, {
        cause: $("#fCause", d).value, also_mob: $("#fMob", d)?.checked ?? false, ...readWhen(d, "f"),
      });
      await done(`${label(a)} recorded as dead`, r.batch);
    },
  }));

  root.querySelectorAll("[data-undo]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Undo this?")) return;
      try {
        await send("POST", `/api/undo/${b.dataset.undo}`);
        await ctx.refresh();
        ctx.toast("Undone");
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
  });
}

/** A small pop-up with the given fields, a "when", and a save button. */
function formDialog(ctx, { title, fields, go, submit }) {
  const d = ctx.dialog;
  d.innerHTML = `
    <div class="dlg narrow">
      <header><h2>${escapeHtml(title)}</h2></header>
      <div class="body">${fields}${whenHtml("f")}</div>
      <footer><button class="btn" id="fCancel">Cancel</button><button class="btn primary" id="fGo">${escapeHtml(go)}</button></footer>
    </div>`;
  bindWhen(d, "f");
  $("#fCancel", d).onclick = () => d.close();
  $("#fGo", d).onclick = async () => {
    const btn = $("#fGo", d);
    btn.disabled = true;
    try {
      await submit(d);
      d.close();
    } catch (e) {
      btn.disabled = false;
      showError(d, e.message);
    }
  };
  d.showModal();
  d.querySelector("input, textarea")?.focus();
}

/* ------------------------------ mob's animals ------------------------------ */

/** The animals with records in a mob, for the mob page. */
export async function loadMobAnimals(ctx, m, el) {
  let list;
  try {
    list = await get(`/api/mobs/${m.id}/animals`);
  } catch {
    el.innerHTML = "";
    return;
  }
  if (!el.isConnected) return;
  const importBtn = ctx.canEdit
    ? `<div class="btns"><button class="btn" id="mImportSession">Import a cattle session for this mob…</button></div>`
    : "";
  const bindImport = () => {
    const b = el.querySelector("#mImportSession");
    if (b) b.onclick = () => ctx.startImport("session", m.id);
  };
  if (!list.length) {
    el.innerHTML = `<p class="muted small">No individual animal records yet. A session from the scales adds them, with their EIDs, tags and weights.</p>${importBtn}`;
    bindImport();
    return;
  }
  const alive = list.filter((a) => a.status === "alive");
  const weighed = alive.filter((a) => a.last_weight_kg != null);
  const mean = weighed.length ? weighed.reduce((t, a) => t + a.last_weight_kg, 0) / weighed.length : null;
  // The mob's own weight (what AE and stocking use) against its animals'
  // recent weights: only animals weighed within a fortnight of the newest, and
  // enough of them, so a few old readings don't raise a false alarm.
  const newest = weighed.map((a) => a.last_weighed).filter(Boolean).sort().pop();
  const cutoff = newest ? new Date(Date.parse(`${newest}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10) : null;
  const recent = cutoff ? weighed.filter((a) => a.last_weighed >= cutoff) : [];
  const recentMean = recent.length ? recent.reduce((t, a) => t + a.last_weight_kg, 0) / recent.length : null;
  const mobKg = m.est_weight_kg ?? m.weight_kg;
  const mismatch = recentMean !== null && mobKg && recent.length >= Math.min(m.head, Math.max(10, Math.ceil(m.head * 0.1)))
    && Math.abs(recentMean - mobKg) / mobKg > 0.05;
  el.innerHTML = `
    <p class="small">${alive.length === m.head ? `All ${m.head} hd have records` : `${alive.length} animal records for ${m.head} hd`}${list.length > alive.length ? ` (plus ${list.length - alive.length} dead, sold or gone)` : ""}${mean ? ` · latest weights average <b>${nf0.format(mean)} kg</b>` : ""}.</p>
    ${mismatch ? `<div class="note warn small">The mob is down as <b>${nf0.format(mobKg)} kg</b>, but the ${recent.length} animals weighed most recently (to ${day(newest)}) average <b>${nf0.format(recentMean)} kg</b>. AE and stocking go by the mob's weight: record a weighing if the animals are right.</div>` : ""}
    ${alive.length > m.head ? `<p class="note warn small">${alive.length - m.head} more animal record${alive.length - m.head === 1 ? "" : "s"} than head. If the mob has had deaths or sales, open the animal and record it — untick “take 1 hd off” where the mob's count already allows for it.</p>`
      : alive.length < m.head ? `<p class="muted tiny">${m.head - alive.length} hd have no individual record yet.</p>` : ""}
    ${ctx.canEdit && alive.some((a) => !a.sex) ? `<div class="setsex small">
      <span>${alive.filter((a) => !a.sex).length} without a sex recorded. Set them all to</span>
      ${["female", "steer", "male", "stag"].map((x) => `<button class="chipbtn" data-mobsex="${x}">${SEX[x]}</button>`).join("")}
    </div>` : ""}
    <table class="list"><tbody>${list.map((a) => `
      <tr class="row" data-animal="${a.id}"><td>${escapeHtml(a.tag || eidText(a.eid))}${a.status !== "alive" ? ` <span class="chip">${a.status}</span>` : ""}</td>
      <td class="muted small">${escapeHtml(SEX[a.sex] || "")}</td>
      <td class="num">${a.last_weight_kg != null ? `${nf0.format(a.last_weight_kg)} kg` : ""}</td>
      <td class="muted small">${day(a.last_weighed)}</td></tr>`).join("")}
    </tbody></table>`;
  el.insertAdjacentHTML("beforeend", importBtn);
  bindImport();
  el.querySelectorAll("[data-mobsex]").forEach((b) => {
    b.onclick = async () => {
      const n = alive.filter((a) => !a.sex).length;
      if (!confirm(`Set ${n} animal${n === 1 ? "" : "s"} in ${m.name} to ${SEX[b.dataset.mobsex].toLowerCase()}? Animals with a sex already recorded are left as they are.`)) return;
      try {
        const r = await send("POST", `/api/mobs/${m.id}/animals/sex`, { sex: b.dataset.mobsex });
        await ctx.refresh();
        ctx.toast(`${r.updated} animal${r.updated === 1 ? "" : "s"} set to ${SEX[b.dataset.mobsex].toLowerCase()}`);
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
  });
  el.querySelectorAll("[data-animal]").forEach((tr) => {
    tr.onclick = () => ctx.selectAnimal(Number(tr.dataset.animal));
  });
}

/* ------------------------------ Animals tab -------------------------------- */

/**
 * Every animal with a record, searchable by tag, EID or NLIS and filtered by
 * status and mob. The filters are remembered for the session in ctx.animalFilter.
 */
export async function renderAnimalsTab(ctx, el) {
  const f = (ctx.animalFilter ||= { q: "", status: "onhand", mob: "" });
  const mobs = [...ctx.state.mobs].sort((x, y) => x.name.localeCompare(y.name));
  el.innerHTML = `
    <div class="f"><input id="anQ" type="search" placeholder="Tag, EID or NLIS number…" value="${escapeHtml(f.q)}" autocomplete="off"></div>
    <div class="row2">
      <select id="anStatus" aria-label="Status">
        ${[["onhand", "On hand"], ["unplaced", "Not in a mob"], ["sold", "Sold"], ["dead", "Dead"], ["gone", "Off the books"], ["all", "All"]].map(([v, t]) => `<option value="${v}"${f.status === v ? " selected" : ""}>${t}</option>`).join("")}
      </select>
      <select id="anMob" aria-label="Mob"><option value="">All mobs</option>${mobs.map((m) => `<option value="${m.id}"${String(m.id) === f.mob ? " selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</select>
    </div>
    <div id="anGroups"></div>
    <div id="anList"><p class="muted small">Loading…</p></div>
    <div class="btns"><button class="btn" id="anReports">Reports…</button>${ctx.canEdit ? '<button class="btn" data-import="session">Import a cattle session…</button>' : ""}</div>`;
  el.querySelector("#anReports").onclick = () => openReports(ctx);

  const list = el.querySelector("#anList");
  const groupsEl = el.querySelector("#anGroups");
  // "Not in a mob": the lots an import couldn't place, to put in their mob in one go.
  const loadGroups = async () => {
    groupsEl.innerHTML = "";
    if (f.status !== "unplaced" || !ctx.canEdit) return;
    let g;
    try { g = (await get("/api/animals/unplaced")).groups; } catch { return; }
    if (!g.length) return;
    const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
    groupsEl.innerHTML = `<h3>Put in a mob</h3>
      <p class="muted small">Grouped by the session each was last seen in. Records only: no mob's head count changes. One Undo reverses each.</p>
      <table class="list"><tbody>${g.map((x, i) => `<tr>
        <td><b>${x.head}</b> hd · ${escapeHtml(x.name)} <span class="muted">${day(x.date)}</span>
          <div class="muted tiny">${Object.entries(x.sexes).map(([k, n]) => `${n} ${escapeHtml(k)}`).join(", ")}</div></td>
        <td>${Object.keys(x.sexes).length > 1 ? `<select data-pgs="${i}" aria-label="Which of them"><option value="">All ${x.head}</option>${Object.entries(x.sexes).map(([k, n]) => `<option value="${escapeHtml(k)}">Only the ${n} ${escapeHtml(k)}</option>`).join("")}</select>` : ""}
          <select data-pg="${i}" aria-label="Mob for this group"><option value="">Choose…</option>
          ${mobs.map((m) => `<option value="${m.id}">${escapeHtml(m.name)} · ${m.head} hd</option>`).join("")}
          <option value="gone">Off the books (gone)</option></select></td>
        <td><button class="btn" data-pgo="${i}">Put</button></td></tr>`).join("")}</tbody></table>`;
    groupsEl.querySelectorAll("[data-pgo]").forEach((b) => {
      b.onclick = async () => {
        const i = Number(b.dataset.pgo);
        const v = groupsEl.querySelector(`[data-pg="${i}"]`).value;
        if (!v) { ctx.toast("Choose a mob first", { error: true }); return; }
        b.disabled = true;
        try {
          const sx = groupsEl.querySelector(`[data-pgs="${i}"]`);
          const r = await send("POST", "/api/animals/unplaced/place", { session_id: g[i].session_id, mob_id: v === "gone" ? "gone" : Number(v), sex: sx && sx.value ? sx.value : null });
          undoable(ctx, r.summary, r.batch);
          loadGroups();
          load();
        } catch (e) {
          b.disabled = false;
          ctx.toast(e.message, { error: true });
        }
      };
    });
  };
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    const params = new URLSearchParams({ q: f.q, status: f.status, ...(f.mob ? { mob: f.mob } : {}) });
    let r;
    try {
      r = await get(`/api/animals?${params}`);
    } catch (e) {
      list.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
      return;
    }
    if (mine !== seq) return; // a later keystroke has already asked again
    if (!r.total) {
      list.innerHTML = `<p class="muted small">${f.q || f.mob || f.status !== "onhand" ? "No animals match." : "No individual animal records yet. Import a cattle session to add them."}</p>`;
      return;
    }
    list.innerHTML = `
      <p class="muted small">${r.total} animal${r.total === 1 ? "" : "s"}${r.total > r.animals.length ? `, showing the first ${r.animals.length}` : ""}</p>
      <table class="list"><thead><tr><th>Tag</th><th>Sex</th><th>Mob</th><th class="num">Weight</th></tr></thead><tbody>
      ${r.animals.map((a) => `<tr class="row" data-animal="${a.id}">
        <td>${escapeHtml(a.tag || eidText(a.eid))}${a.status !== "alive" ? ` <span class="chip">${a.status} ${day(a.status_date)}</span>` : ""}</td>
        <td class="muted small">${escapeHtml(SEX[a.sex] || "")}</td>
        <td class="muted small">${escapeHtml(a.mob_name || "")}</td>
        <td class="num">${a.last_weight_kg != null ? `${nf0.format(a.last_weight_kg)} kg` : ""}</td></tr>`).join("")}
      </tbody></table>`;
    list.querySelectorAll("[data-animal]").forEach((tr) => {
      tr.onclick = () => ctx.selectAnimal(Number(tr.dataset.animal));
    });
  };
  let timer;
  el.querySelector("#anQ").addEventListener("input", (e) => {
    f.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  el.querySelector("#anStatus").onchange = (e) => { f.status = e.target.value; load(); loadGroups(); };
  el.querySelector("#anMob").onchange = (e) => { f.mob = e.target.value; load(); };
  const imp = el.querySelector("[data-import]");
  if (imp) imp.onclick = () => ctx.startImport("session");
  load();
  loadGroups();
}

/* -------------------------------- search ----------------------------------- */

/** Search results in the panel, when a search matches several animals. */
export function renderAnimalResults(ctx, q, list, root) {
  root.innerHTML = `
    <button class="linkbtn back" id="back">← Back</button>
    <h2>Animals matching “${escapeHtml(q)}”</h2>
    <table class="list"><tbody>${list.map((a) => `
      <tr class="row" data-animal="${a.id}"><td>${escapeHtml(a.tag || "")}<div class="muted tiny">${escapeHtml(eidText(a.eid))}</div></td>
      <td class="muted small">${escapeHtml(a.mob_name || "")}${a.status !== "alive" ? ` · ${a.status}` : ""}</td>
      <td class="num">${a.last_weight_kg != null ? `${nf0.format(a.last_weight_kg)} kg` : ""}</td></tr>`).join("")}
    </tbody></table>`;
  $("#back", root).onclick = ctx.backToMobs;
  root.querySelectorAll("[data-animal]").forEach((tr) => {
    tr.onclick = () => ctx.selectAnimal(Number(tr.dataset.animal));
  });
}
