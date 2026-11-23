/**
 * Feed checks: what you see in a paddock while driving past. A quick rating
 * (eaten down, getting short, fair, plenty) or a kg/ha estimate. The pasture
 * model starts the paddock from the newest check until a newer Cibo reading
 * comes in, so the Rotation tab follows what's on the ground.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";
import { forgetRotation } from "./plan.js";

const pad2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayIso = () => iso(new Date());
const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const nf = (n) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: 0 });
const daysAgo = (d) => Math.round((Date.parse(`${todayIso()}T00:00:00`) - Date.parse(`${d}T00:00:00`)) / 86_400_000);
const agoText = (d) => { const n = daysAgo(d); return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`; };
export const RATING_WORDS = { eaten: "Eaten down", short: "Getting short", fair: "Fair", plenty: "Plenty" };
const checkText = (c) => `${c.rating ? `<b>${RATING_WORDS[c.rating]}</b>, about` : "About"} ${nf(c.kg_ha)} kg/ha`;

export function feedCheckSectionHtml() {
  return `<div id="feedCheckBox"><h3>Feed checks</h3><div id="feedChecks"><p class="muted small">Loading…</p></div></div>`;
}

/** The paddock's checks, newest first, and a button to record one. */
export async function loadFeedChecks(ctx, f, root) {
  const el = root.querySelector("#feedChecks");
  if (!el) return;
  let data;
  try { data = await get(`/api/feed-checks?paddock=${f.id}`); } catch { data = null; }
  if (!el.isConnected) return;
  if (!data) { el.innerHTML = '<p class="muted small">Feed checks need signal.</p>'; return; }
  const name = f.properties.name || "this paddock";
  const reload = () => { forgetRotation(); loadFeedChecks(ctx, f, root); };
  const [cur, ...older] = data.checks;
  el.innerHTML = `
    ${cur ? `<p class="small">${checkText(cur)} on <b>${day(cur.checked_on)}</b> <span class="muted">(${agoText(cur.checked_on)}${cur.username ? `, ${escapeHtml(cur.username)}` : ""})</span>${cur.note ? `<br>${escapeHtml(cur.note)}` : ""}
      ${ctx.canEdit ? ` <button class="linkbtn" data-del-check="${cur.id}">Delete</button>` : ""}</p>
      <p class="muted tiny">The Rotation tab and the pasture outlook start ${escapeHtml(name)} from this check until a newer Cibo reading comes in.</p>`
      : `<p class="muted small">No feed checks. When you see the feed is different from what the Rotation tab thinks, record what you see here.</p>`}
    ${older.length ? `<details><summary class="small">Earlier checks (${older.length})</summary><ul class="history">
      ${older.map((c) => `<li>${day(c.checked_on)}: ${checkText(c)}${c.note ? ` · ${escapeHtml(c.note)}` : ""}${ctx.canEdit ? ` <button class="linkbtn" data-del-check="${c.id}">Delete</button>` : ""}</li>`).join("")}
    </ul></details>` : ""}
    ${ctx.canEdit ? '<div class="btns"><button class="btn" id="checkAdd">Record a feed check…</button></div>' : ""}`;
  el.querySelector("#checkAdd")?.addEventListener("click", () => feedCheckDialog(ctx, [{ id: f.id, name }], {}, reload));
  el.querySelectorAll("[data-del-check]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this feed check?")) return;
      try { await send("DELETE", `/api/feed-checks/${b.dataset.delCheck}`); ctx.toast("Feed check deleted"); reload(); }
      catch (e) { ctx.toast(e.message, { error: true }); }
    };
  });
}

/**
 * Record a check. paddocks: [{id, name}], more than one when a mob is in
 * several (pick which). opts.now: the planner's figure for today, to compare.
 */
export async function feedCheckDialog(ctx, paddocks, opts, after) {
  const d = ctx.dialog;
  let pid = paddocks[0].id;
  d.innerHTML = '<div class="dlg narrow"><div class="body"><p class="muted">Loading…</p></div></div>';
  if (!d.open) d.showModal();
  let info;
  const load = async () => {
    try { info = await get(`/api/feed-checks?paddock=${pid}`); }
    catch (e) { d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`; return false; }
    return true;
  };
  if (!(await load())) return;
  let rating = null;

  const draw = () => {
    const name = paddocks.find((p) => p.id === pid)?.name || "the paddock";
    d.innerHTML = `
      <div class="dlg narrow">
        <header><h2>Feed check</h2></header>
        <div class="body">
          ${paddocks.length > 1 ? `<div class="f"><label for="fcPad">Paddock</label><select id="fcPad">${paddocks.map((p) => `<option value="${p.id}"${p.id === pid ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></div>`
            : `<p><b>${escapeHtml(name)}</b></p>`}
          ${opts.now != null ? `<p class="muted small">The Rotation tab thinks there's about <b>${nf(opts.now)} kg/ha</b>${paddocks.length > 1 ? " across them" : ""} today.</p>` : ""}
          <div class="f"><label for="fcDay">Checked on</label><input id="fcDay" type="date" max="${todayIso()}" value="${todayIso()}"></div>
          <div class="f"><label>How much feed is there?</label>
            <div class="ratings">${info.ratings.map((r) => `<button type="button" class="btn rating${rating === r.key ? " primary" : ""}" data-rating="${r.key}">${escapeHtml(r.label)}<span class="tiny">about ${nf(r.kg_ha)} kg/ha</span></button>`).join("")}</div>
            <p class="muted tiny">The kg/ha each one stands for is worked out from this paddock's floor (${nf(info.floor)} kg/ha): "eaten down" is just under it, so the mob is due to move now.</p>
          </div>
          <div class="f"><label for="fcKg">Or your own estimate, kg/ha</label><input id="fcKg" type="number" min="50" max="15000" step="50" inputmode="numeric" placeholder="optional"></div>
          <div class="f"><label for="fcNote">Note</label><textarea id="fcNote" rows="2" placeholder="e.g. Grass eaten to the ground near the trough"></textarea></div>
        </div>
        <footer class="btns"><button class="btn" id="fcCancel">Cancel</button><button class="btn primary" id="fcGo">Save</button></footer>
      </div>`;
    const $ = (s) => d.querySelector(s);
    $("#fcPad")?.addEventListener("change", async (e) => {
      pid = Number(e.target.value);
      if (await load()) draw();
    });
    d.querySelectorAll("[data-rating]").forEach((b) => {
      b.onclick = () => {
        rating = rating === b.dataset.rating ? null : b.dataset.rating;
        d.querySelectorAll("[data-rating]").forEach((x) => x.classList.toggle("primary", x.dataset.rating === rating));
        if (rating) $("#fcKg").value = "";
      };
    });
    // Typing a figure replaces the rating.
    $("#fcKg").oninput = () => {
      if ($("#fcKg").value.trim()) { rating = null; d.querySelectorAll("[data-rating]").forEach((x) => x.classList.remove("primary")); }
    };
    $("#fcCancel").onclick = () => d.close();
    $("#fcGo").onclick = async () => {
      const kg = $("#fcKg").value.trim();
      if (!rating && !kg) { ctx.toast("Pick how much feed there is, or give a kg/ha", { error: true }); return; }
      const btn = $("#fcGo");
      btn.disabled = true;
      try {
        await send("POST", "/api/feed-checks", { feature_id: pid, checked_on: $("#fcDay").value, rating, kg_ha: kg, note: $("#fcNote").value });
        d.close();
        ctx.toast(`Feed check for ${name} saved: the Rotation tab is being worked out again`);
        forgetRotation();
        after?.();
      } catch (e) {
        btn.disabled = false;
        ctx.toast(e.message, { error: true });
      }
    };
  };
  draw();
}
