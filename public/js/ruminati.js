/**
 * Ruminati inputs: the Cattle page worked out from the mob records, laid out
 * the way Ruminati asks for it — each class with its average head, liveweight
 * and daily gain for Spring, Summer, Autumn and Winter — ready to type in.
 *
 * Under it, the mobs behind the figures (to fix a missing birth date, which
 * decides the age class) and the purchases and sales from before the app's
 * records began, taken from the NVDs.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const SEASONS = ["Spring", "Summer", "Autumn", "Winter"];
const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** The financial year just finished, by its end: before July it's last year's. */
function lastFy() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

export async function openRuminati(ctx) {
  const d = ctx.dialog;
  let fy = lastFy();
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Working it out…</p></div></div>';
  if (!d.open) d.showModal();

  const load = async () => {
    try {
      draw(await get(`/api/ruminati/cattle?fy=${fy}`));
    } catch (e) {
      d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    }
  };

  const cell = (s, k) => {
    if (k === "head") return s.head ? String(s.head) : '<span class="muted">0</span>';
    if (!s.head) return "";
    if (k === "lw") return s.liveweight === null ? '<span class="muted">no weight</span>'
      : `${s.liveweight}${s.weight_cover < 90 ? ` <span class="muted tiny" title="Share of the head with a weight">${s.weight_cover}%</span>` : ""}`;
    return s.adg === null ? '<span class="muted">—</span>'
      : `${s.adg.toFixed(2)}${s.gain_cover < 90 ? ` <span class="muted tiny" title="Share of the head with a gain between two weighings">${s.gain_cover}%</span>` : ""}`;
  };

  const draw = (r) => {
    const fys = [lastFy() + 1, lastFy(), lastFy() - 1];
    const pre = r.pre_records.map((p) => ({ ...p }));
    const mobs = r.all_mobs;
    d.innerHTML = `
      <div class="dlg wide report">
        <header>
          <h2>Ruminati · Cattle</h2>
          <div class="row2">
            <div class="f"><label for="ruFy">Financial year</label>
              <select id="ruFy">${fys.map((y) => `<option value="${y}"${y === fy ? " selected" : ""}>${y - 1}/${String(y).slice(2)} (to 30 June ${y})</option>`).join("")}</select></div>
          </div>
        </header>
        <div class="body">
          <p class="muted small">${day(r.from)} to ${day(r.to)}. Seasons: Spring Sep–Nov, Summer Dec–Feb, Autumn Mar–May, Winter Jun–Aug (July–August at the start of the year and June at its end).
            Each mob is put in a class by its age on each day, so a mob that turns two partway through counts in both. Agisted cattle are included.</p>
          ${r.classes.map((c) => `
            <h3>${escapeHtml(c.class)}</h3>
            <table class="list ruminati"><thead><tr><th></th>${SEASONS.map((s) => `<th class="num">${s}</th>`).join("")}</tr></thead><tbody>
              <tr><td>Average head</td>${SEASONS.map((s) => `<td class="num">${cell(c.seasons.find((x) => x.season === s), "head")}</td>`).join("")}</tr>
              <tr><td>Liveweight <span class="muted">kg/hd</span></td>${SEASONS.map((s) => `<td class="num">${cell(c.seasons.find((x) => x.season === s), "lw")}</td>`).join("")}</tr>
              <tr><td>Daily gain <span class="muted">kg/hd/day</span></td>${SEASONS.map((s) => `<td class="num">${cell(c.seasons.find((x) => x.season === s), "adg")}</td>`).join("")}</tr>
            </tbody></table>`).join("") || '<p class="muted">No cattle on hand in that year.</p>'}
          <p class="muted tiny">A small % beside a figure is how much of that class's head it rests on; the rest had no weight, or no second weighing to give a gain. Weights between weighings are drawn as a straight line and held flat before the first and after the last, so gains only come from mobs weighed at least twice. Leave a gain blank and Ruminati's <b>Calculate</b> works one out from the seasonal weights.</p>

          <h3>The mobs behind it</h3>
          <table class="list"><thead><tr><th>Mob</th><th class="num">Avg head</th><th>Born</th><th>Notes</th></tr></thead><tbody>
            ${r.mobs.map((m, i) => `<tr><td>${escapeHtml(m.name)}${m.records > 1 ? ` <span class="muted tiny">${m.records} records</span>` : ""}${m.owner ? `<div class="muted tiny">owner ${escapeHtml(m.owner)}</div>` : ""}</td>
              <td class="num">${m.avg_head}</td>
              <td>${m.births.map((b) => escapeHtml(b.slice(0, 7))).join(", ")}${m.missing_birth ? `${m.births.length ? "<br>" : ""}<span class="bad tiny">${m.missing_birth === m.records ? "not recorded" : `${m.missing_birth} without`}</span>${ctx.canEdit ? `<div class="birthset"><input type="month" data-bm="${i}" aria-label="Birth month for ${escapeHtml(m.name)}"><button class="linkbtn" data-bset="${i}">Set</button></div>` : ""}` : ""}</td>
              <td class="tiny">${[m.split ? `split ${escapeHtml(m.split)}` : "", m.no_weight ? "never weighed" : m.listed_only ? "AgriWebb's listed weight only" : ""].filter(Boolean).join("; ")}
                ${ctx.canEdit || m.unweaned ? `<div class="unweaned"><label class="radio"><input type="checkbox" data-uw="${i}"${m.unweaned ? " checked" : ""}${ctx.canEdit ? "" : " disabled"}> Unweaned calves</label>${m.unweaned ? ` <span class="muted">weaned</span> <input type="date" data-uwd="${i}" value="${m.weaned_on || ""}"${ctx.canEdit ? "" : " disabled"}>` : ""}</div>` : ""}</td></tr>`).join("")}
          </tbody></table>
          <p class="muted tiny">Tick <b>Unweaned calves</b> for calves still on their mothers: Ruminati counts them within the cows, so they're left out of the classes until the weaning date (blank: not weaned by the end of the year).</p>
          <p class="muted tiny">A mob without a birth date is aged from its group (weaners under one, cows over two, the rest one to two), which may put it in the wrong class. Setting a birth month here fills every mob record of that name that has none.</p>

          <h3>Before the records</h3>
          <p class="muted small">The app's records begin ${r.records_begin ? day(r.records_begin) : "—"}. Mobs on hand then are carried back to 1 July, undoing these purchases (+) and sales (−) from the NVDs.${r.carried_back.length ? ` Carried back: ${r.carried_back.length} mob${r.carried_back.length === 1 ? "" : "s"}.` : ""}</p>
          <table class="list" id="ruPre"><thead><tr><th>Date</th><th>Mob</th><th class="num">Head</th><th>Note</th><th></th></tr></thead><tbody></tbody></table>
          ${ctx.canEdit ? '<div class="btns"><button class="btn" id="ruPreAdd">Add a line</button><button class="btn primary" id="ruPreSave">Save and recalculate</button></div>' : ""}
        </div>
        <footer class="btns"><button class="btn" id="ruClose">Close</button><button class="btn" id="ruPrint">Print</button></footer>
      </div>`;

    const preBody = d.querySelector("#ruPre tbody");
    const drawPre = () => {
      preBody.innerHTML = pre.map((p, i) => `<tr>
        <td><input type="date" data-pd="${i}" value="${escapeHtml(p.date)}"></td>
        <td><select data-pm="${i}"><option value="">Choose…</option>${mobs.map((m) => `<option value="${m.id}"${m.id === p.mob_id ? " selected" : ""}>${escapeHtml(m.name)} · ${m.head} hd on ${escapeHtml(day(m.from))}</option>`).join("")}
</select></td>
        <td class="num"><input type="number" step="1" data-ph="${i}" value="${p.head_change ?? ""}" placeholder="+96 / −12"></td>
        <td><input data-pn="${i}" value="${escapeHtml(p.note || "")}" placeholder="e.g. NVD, Jim Bishop, Rolleston"></td>
        <td>${ctx.canEdit ? `<button class="linkbtn danger-link" data-pdel="${i}">Remove</button>` : ""}</td></tr>`).join("")
        || '<tr><td colspan="5" class="muted small">None yet.</td></tr>';
      preBody.querySelectorAll("[data-pd]").forEach((x) => { x.onchange = () => { pre[x.dataset.pd].date = x.value; }; });
      preBody.querySelectorAll("[data-pm]").forEach((x) => { x.onchange = () => { pre[x.dataset.pm].mob_id = Number(x.value); }; });
      preBody.querySelectorAll("[data-ph]").forEach((x) => { x.onchange = () => { pre[x.dataset.ph].head_change = Number(x.value); }; });
      preBody.querySelectorAll("[data-pn]").forEach((x) => { x.onchange = () => { pre[x.dataset.pn].note = x.value; }; });
      preBody.querySelectorAll("[data-pdel]").forEach((x) => { x.onclick = () => { pre.splice(Number(x.dataset.pdel), 1); drawPre(); }; });
    };
    drawPre();

    d.querySelector("#ruFy").onchange = (e) => { fy = Number(e.target.value); load(); };
    d.querySelector("#ruClose").onclick = () => d.close();
    d.querySelector("#ruPrint").onclick = () => {
      document.body.classList.add("printing-report");
      window.print();
      setTimeout(() => document.body.classList.remove("printing-report"), 500);
    };
    const add = d.querySelector("#ruPreAdd");
    if (add) add.onclick = () => { pre.push({ date: `${fy - 1}-07-01`, mob_id: null, head_change: null, note: "" }); drawPre(); };
    const save = d.querySelector("#ruPreSave");
    if (save) save.onclick = async () => {
      try {
        await send("PUT", "/api/ruminati/pre-records", { list: pre });
        ctx.toast("Saved");
        load();
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
    const saveUw = async (i) => {
      const box = d.querySelector(`[data-uw="${i}"]`);
      const date = d.querySelector(`[data-uwd="${i}"]`);
      try {
        await send("POST", "/api/ruminati/unweaned", { name: r.mobs[i].name, on: box.checked, weaned_on: date ? date.value : null });
        load();
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
    d.querySelectorAll("[data-uw]").forEach((b) => { b.onchange = () => saveUw(Number(b.dataset.uw)); });
    d.querySelectorAll("[data-uwd]").forEach((b) => { b.onchange = () => saveUw(Number(b.dataset.uwd)); });
    d.querySelectorAll("[data-bset]").forEach((b) => {
      b.onclick = async () => {
        const i = Number(b.dataset.bset);
        const v = d.querySelector(`[data-bm="${i}"]`).value;
        if (!v) { ctx.toast("Choose the month they were born", { error: true }); return; }
        try {
          const res = await send("POST", "/api/ruminati/birth", { name: r.mobs[i].name, birth_date: `${v}-01` });
          ctx.toast(`Birth date set on ${res.mobs} mob record${res.mobs === 1 ? "" : "s"}`);
          load();
        } catch (e) {
          ctx.toast(e.message, { error: true });
        }
      };
    });
  };
  load();
}
