/**
 * Plantings on a paddock: when a crop went in, what it was, the seeding and
 * fertiliser rates, and when it'll be ready to graze. Shown on the paddock's
 * page; the Rotation tab leaves the paddock out until the newest one is ready.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";
import { forgetRotation } from "./plan.js";

const READY_DAYS = 56; // as the server guesses with no ready date (src/pasture/plantings.ts)
const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "");
const pad2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayIso = () => iso(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return iso(x); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86_400_000);
const readyOf = (p) => p.ready_on || addDays(p.sown_on, READY_DAYS);

export function plantingsSectionHtml() {
  return `<div id="plantingsBox"><h3>Plantings</h3><div id="plantings"><p class="muted small">Loading…</p></div></div>`;
}

/** The paddock's plantings, newest first. Hidden on a grazing paddock that has never had one. */
export async function loadPlantings(ctx, f, root) {
  const box = root.querySelector("#plantingsBox");
  const el = root.querySelector("#plantings");
  if (!el) return;
  const cultivation = f.properties.subtype === "cultivation";
  let list;
  try { list = await get(`/api/plantings?paddock=${f.id}`); } catch { list = null; }
  if (!el.isConnected) return;
  if (!list) { el.innerHTML = '<p class="muted small">Plantings need signal.</p>'; return; }
  if (!list.length && !cultivation) { box.hidden = !ctx.canEdit; }
  const name = f.properties.name || "this paddock";
  const reload = () => { forgetRotation(); loadPlantings(ctx, f, root); };
  const today = todayIso();
  const [cur, ...older] = list;
  const mix = (p) => p.crops.length > 1 || p.crops[0]?.rate_kg_ha != null;
  const cropsText = (p) => p.crops.map((c) => `${escapeHtml(c.crop)}${c.rate_kg_ha != null ? ` ${c.rate_kg_ha} kg/ha` : ""}`).join(" + ");
  const line = (p) => [
    mix(p) ? `Seed: ${cropsText(p)}${p.crops.length > 1 && p.rate_kg_ha != null ? ` (${p.rate_kg_ha} kg/ha in all)` : ""}` : null,
    p.fertiliser ? escapeHtml(p.fertiliser) : null,
  ].filter(Boolean).join(" · ");
  el.innerHTML = `
    ${cur ? (() => {
      const ready = readyOf(cur);
      const left = daysBetween(today, ready);
      return `<div class="planting">
        <div><b>${escapeHtml(cur.crop)}</b>, planted <b>${day(cur.sown_on)}</b> <span class="muted">(${daysBetween(cur.sown_on, today)} days ago)</span></div>
        ${line(cur) ? `<div class="small">${line(cur)}</div>` : ""}
        <div class="small">${left > 0
          ? `<b class="warnc">Not ready to graze until ${day(ready)}</b> (${left} days)${cur.ready_on ? "" : ", about 8 weeks after planting: change it if you expect otherwise"}. The Rotation tab won't suggest it for a mob moving before then.`
          : `Ready to graze from ${day(ready)}.`}</div>
        ${cur.note ? `<p class="small">${escapeHtml(cur.note)}</p>` : ""}
        ${ctx.canEdit ? `<div class="btns"><button class="btn" data-edit-planting="${cur.id}">Change…</button>${left > 0 ? `<button class="btn" data-ready-now="${cur.id}">Ready now</button>` : ""}</div>` : ""}
      </div>`;
    })() : `<p class="muted small">No plantings recorded.</p>`}
    ${older.length ? `<details><summary class="small">Earlier plantings (${older.length})</summary><ul class="history">
      ${older.map((p) => `<li><b>${escapeHtml(p.crop)}</b> ${day(p.sown_on)}${line(p) ? ` · ${line(p)}` : ""}${p.note ? ` · ${escapeHtml(p.note)}` : ""}
        ${ctx.canEdit ? ` <button class="linkbtn" data-edit-planting="${p.id}">Change</button>` : ""}</li>`).join("")}
    </ul></details>` : ""}
    ${ctx.canEdit ? '<div class="btns"><button class="btn" id="plantAdd">Record a planting…</button></div>' : ""}`;
  el.querySelector("#plantAdd")?.addEventListener("click", () => plantingDialog(ctx, f.id, name, null, reload));
  el.querySelectorAll("[data-edit-planting]").forEach((b) => {
    b.onclick = () => plantingDialog(ctx, f.id, name, list.find((p) => p.id === Number(b.dataset.editPlanting)), reload);
  });
  el.querySelectorAll("[data-ready-now]").forEach((b) => {
    b.onclick = async () => {
      try {
        await send("PATCH", `/api/plantings/${b.dataset.readyNow}`, { ready_on: today });
        ctx.toast(`${name} marked ready to graze`);
        reload();
      } catch (e) { ctx.toast(e.message, { error: true }); }
    };
  });
}

function plantingDialog(ctx, featureId, name, p, after) {
  const d = ctx.dialog;
  const today = todayIso();
  d.innerHTML = `
    <div class="dlg narrow">
      <header><h2>${p ? "Change the planting in" : "Planting in"} ${escapeHtml(name)}</h2></header>
      <div class="body">
        <div class="f"><label for="plSown">Date planted</label><input id="plSown" type="date" value="${escapeHtml(p?.sown_on || today)}"></div>
        <div class="croprows" id="plCrops"></div>
        <datalist id="plCropList"><option value="Oats"><option value="Barley"><option value="Forage sorghum"><option value="Millet"><option value="Lablab"><option value="Ryegrass"><option value="Wheat"><option value="Vetch"><option value="Medic"><option value="Clover"><option value="Rhodes grass"></datalist>
        <div class="btns"><button class="btn" id="plAddCrop" type="button">+ Add another crop</button></div>
        <p class="muted tiny" id="plTotal"></p>
        <div class="f"><label for="plFert">Fertiliser and rate</label><input id="plFert" value="${escapeHtml(p?.fertiliser || "")}" placeholder="e.g. Urea 50 kg/ha"></div>
        <div class="f"><label for="plReady">Ready to graze from</label><input id="plReady" type="date" value="${escapeHtml(p?.ready_on || "")}">
          <p class="muted tiny" id="plReadyHint"></p></div>
        <div class="f"><label for="plNote">Note</label><textarea id="plNote" rows="2" placeholder="e.g. Sown into moisture after 40 mm">${escapeHtml(p?.note || "")}</textarea></div>
      </div>
      <footer class="btns">
        ${p ? '<button class="btn danger" id="plDel">Delete</button>' : ""}
        <button class="btn" id="plCancel">Cancel</button><button class="btn primary" id="plGo">Save</button>
      </footer>
    </div>`;
  const $ = (s) => d.querySelector(s);
  const hint = () => {
    const sown = $("#plSown").value;
    const r = $("#plReady").value;
    $("#plReadyHint").textContent = r && sown
      ? `${daysBetween(sown, r)} days (about ${Math.round(daysBetween(sown, r) / 7)} weeks) after planting.`
      : sown ? `Leave it blank to take about 8 weeks after planting (${day(addDays(sown, READY_DAYS))}).` : "";
  };
  $("#plSown").oninput = hint; $("#plReady").oninput = hint; hint();

  // One row per crop in the mix, each with its own seeding rate.
  const rowsEl = $("#plCrops");
  const total = () => {
    const rows = cropRows().filter((c) => c.crop);
    const sum = rows.reduce((t, c) => t + (Number(c.rate_kg_ha) || 0), 0);
    $("#plTotal").textContent = rows.length > 1 && sum ? `${Math.round(sum * 100) / 100} kg/ha of seed in all.` : "";
  };
  const addRow = (c = { crop: "", rate_kg_ha: null }) => {
    const n = rowsEl.children.length + 1;
    const row = document.createElement("div");
    row.className = "croprow";
    row.innerHTML = `
      <div class="f"><label for="plCrop${n}">Crop</label><input id="plCrop${n}" data-crop value="${escapeHtml(c.crop || "")}" placeholder="e.g. Oats (Bimbil)" list="plCropList"></div>
      <div class="f"><label for="plRate${n}">Seed (kg/ha)</label><input id="plRate${n}" data-rate type="number" min="0" step="0.5" inputmode="decimal" value="${c.rate_kg_ha ?? ""}"></div>
      <button class="btn" type="button" data-remove title="Take this crop out">✕</button>`;
    row.querySelector("[data-remove]").onclick = () => { row.remove(); if (!rowsEl.children.length) addRow(); showRemove(); total(); };
    row.querySelectorAll("input").forEach((i) => { i.oninput = total; });
    rowsEl.append(row);
    showRemove();
    return row;
  };
  // The ✕ only shows when there's more than one crop.
  const showRemove = () => rowsEl.querySelectorAll("[data-remove]").forEach((b) => { b.hidden = rowsEl.children.length < 2; });
  const cropRows = () => [...rowsEl.children].map((r) => ({ crop: r.querySelector("[data-crop]").value.trim(), rate_kg_ha: r.querySelector("[data-rate]").value.trim() }));
  (p?.crops?.length ? p.crops : [undefined]).forEach((c) => addRow(c));
  total();
  $("#plAddCrop").onclick = () => addRow().querySelector("[data-crop]").focus();
  $("#plCancel").onclick = () => d.close();
  $("#plDel")?.addEventListener("click", async () => {
    if (!confirm(`Delete this ${p.crop} planting?`)) return;
    try { await send("DELETE", `/api/plantings/${p.id}`); d.close(); ctx.toast("Planting deleted"); after?.(); }
    catch (e) { ctx.toast(e.message, { error: true }); }
  });
  $("#plGo").onclick = async () => {
    const crops = cropRows();
    if (crops.some((c) => !c.crop && c.rate_kg_ha)) { ctx.toast("A seeding rate needs the crop it's for", { error: true }); return; }
    const body = {
      sown_on: $("#plSown").value, crops: crops.filter((c) => c.crop),
      fertiliser: $("#plFert").value, ready_on: $("#plReady").value, note: $("#plNote").value,
    };
    if (!body.sown_on) { ctx.toast("Give the date it was planted", { error: true }); return; }
    if (!body.crops.length) { ctx.toast("Say what was planted", { error: true }); return; }
    const btn = $("#plGo");
    btn.disabled = true;
    try {
      if (p) await send("PATCH", `/api/plantings/${p.id}`, body);
      else await send("POST", "/api/plantings", { feature_id: featureId, ...body });
      d.close();
      ctx.toast(`Planting in ${name} saved`);
      after?.();
    } catch (e) {
      btn.disabled = false;
      ctx.toast(e.message, { error: true });
    }
  };
  d.showModal();
}
