/**
 * Individual animals in the interface: the animal page, its actions (weight,
 * note, death), the list of animals on a mob's page, and search results.
 *
 * Uses the same `ctx` as stockui.js, plus ctx.selectAnimal(id).
 */
import { get, send } from "./api.js";
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

  root.innerHTML = `
    <button class="linkbtn back" id="back">← ${v.mob_id ? escapeHtml(v.mob_name) : "Back"}</button>
    <h2>${escapeHtml(label(a))}</h2>
    <p class="sub">${[a.eid ? `EID ${escapeHtml(eidText(a.eid))}` : null, a.nlis ? `NLIS ${escapeHtml(a.nlis)}` : null].filter(Boolean).join(" · ") || "No EID recorded"}</p>

    <div class="statuscard">
      <div class="big">${alive ? "" : `<span class="gatestate">${v.status === "dead" ? "Dead" : "Sold"} ${day(v.status_date)}</span> `}
        ${v.mob_id ? `<button class="linkbtn" id="aMob">${escapeHtml(v.mob_name)}</button>` : '<span class="muted">Not in a mob</span>'}
        ${here && alive ? ` · ${escapeHtml(here.paddocks.join(" + "))}` : ""}</div>
      <div class="muted small">${last ? `${nf0.format(last.weight_kg)} kg on ${day(last.date)}${last.gain_per_day != null ? ` · ${gain(last.gain_per_day)} since the weighing before` : ""}` : "Not weighed"}</div>
      ${ctx.canEdit && alive ? `<div class="btns">
        <button class="btn primary" id="aWeigh">Record weight…</button>
        <button class="btn" id="aNote">Add note…</button>
        <button class="btn danger" id="aDeath">Record death…</button>
      </div>` : ""}
    </div>

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
    <ul class="history">${v.events.map((e) => {
      const what = {
        join: `Joined ${escapeHtml(e.mob_name || "a mob")}`,
        leave: `Left ${escapeHtml(e.mob_name || "a mob")}`,
        weigh: `Weighed · ${nf1.format(e.weight_kg)} kg`,
        score: `Condition score ${e.score}`,
        note: "Note",
        death: "Died",
        sale: "Sold",
      }[e.kind] || escapeHtml(e.kind);
      const undo = ctx.canEdit && e.batch && e.source === "app";
      return `<li><span class="when">${day(e.date)}${e.time ? `<br><span class="muted tiny">${escapeHtml(e.time)}</span>` : ""}</span>
        <span class="grow">${what}${e.text ? `<br><span class="muted tiny">${escapeHtml(e.text)}</span>` : ""}${e.source.startsWith("session:") ? '<br><span class="muted tiny">from a scales session</span>' : ""}</span>
        ${undo ? `<button class="linkbtn danger-link" data-undo="${e.batch}">Undo</button>` : ""}</li>`;
    }).join("") || '<li class="muted">Nothing recorded.</li>'}</ul>`;

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
  el.innerHTML = `
    <p class="small">${alive.length === m.head ? `All ${m.head} hd have records` : `${alive.length} animal records for ${m.head} hd`}${list.length > alive.length ? ` (plus ${list.length - alive.length} dead or sold)` : ""}${mean ? ` · latest weights average <b>${nf0.format(mean)} kg</b>` : ""}.</p>
    ${alive.length > m.head ? `<p class="note warn small">${alive.length - m.head} more animal record${alive.length - m.head === 1 ? "" : "s"} than head. If the mob has had deaths or sales, open the animal and record it — untick “take 1 hd off” where the mob's count already allows for it.</p>`
      : alive.length < m.head ? `<p class="muted tiny">${m.head - alive.length} hd have no individual record yet.</p>` : ""}
    <table class="list"><tbody>${list.map((a) => `
      <tr class="row" data-animal="${a.id}"><td>${escapeHtml(a.tag || eidText(a.eid))}${a.status !== "alive" ? ` <span class="chip">${a.status}</span>` : ""}</td>
      <td class="num">${a.last_weight_kg != null ? `${nf0.format(a.last_weight_kg)} kg` : ""}</td>
      <td class="muted small">${day(a.last_weighed)}</td></tr>`).join("")}
    </tbody></table>`;
  el.insertAdjacentHTML("beforeend", importBtn);
  bindImport();
  el.querySelectorAll("[data-animal]").forEach((tr) => {
    tr.onclick = () => ctx.selectAnimal(Number(tr.dataset.animal));
  });
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
