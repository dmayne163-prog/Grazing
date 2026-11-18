/**
 * Long-term carrying capacity by paddock (FORAGE): what each paddock can carry
 * year in, year out without running down, against what it has carried over
 * the last 12 months and what's in it now. Land condition (A–D) is set here;
 * FORAGE assumes A everywhere until it is.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const nf = (n, dp = 0) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-AU", { maximumFractionDigits: dp, minimumFractionDigits: dp }));
const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");

/** "A", or "60% A · 40% B". */
export function conditionText(c) {
  if (!c || c.a === 100) return "A";
  return ["a", "b", "c", "d"].filter((k) => c[k] > 0).map((k) => `${c[k]}% ${k.toUpperCase()}`).join(" · ");
}

/** Share of capacity used over the year, with a word for it. */
export function loadText(year, cap) {
  if (!cap || year === null || year === undefined) return { pct: null, cls: "muted" };
  const pct = Math.round((year / cap) * 100);
  return { pct, cls: pct > 110 ? "bad" : pct >= 80 ? "" : "muted" };
}

export async function openCapacity(ctx) {
  const d = ctx.dialog;
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Loading…</p></div></div>';
  if (!d.open) d.showModal();
  let r;
  const load = async () => {
    try {
      r = await get("/api/pasture/capacity");
    } catch (e) {
      d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
      return;
    }
    draw();
  };

  const draw = () => {
    if (!r) {
      d.innerHTML = `<div class="dlg"><div class="body"><p>No paddock carrying capacity yet. Import FORAGE's
        <b>CarryingCapacityFor_Paddock_LandType_dataOutput…csv</b> from the Pasture tab.</p></div>
        <footer class="btns"><button class="btn" id="ccClose">Close</button></footer></div>`;
      d.querySelector("#ccClose").onclick = () => d.close();
      return;
    }
    const t = r.totals;
    const lt = (p) => p.land_types.slice(0, 3).map((l) => `${escapeHtml(l.name)} <span class="muted">${nf(l.share_pct)}%</span>`).join("<br>");
    const row = (p) => {
      const u = loadText(p.ae_year, p.ae);
      // Forage crops are meant to carry more than the native pasture FORAGE models.
      if (p.subtype === "cultivation") u.cls = "muted";
      return `<tr>
        <td><b>${escapeHtml(p.name)}</b>${p.subtype === "cultivation" ? ' <span class="chip">cultivation</span>' : ""}
          <div class="muted tiny">${nf(p.area_ha)} ha</div></td>
        <td class="small">${lt(p)}</td>
        <td>${ctx.canEdit && p.paddock_id ? `<button class="linkbtn" data-cond="${p.paddock_id}">${conditionText(p.condition)}</button>` : conditionText(p.condition)}</td>
        <td class="num"><b>${nf(p.ae)}</b>${p.ae !== p.ae_a ? `<div class="muted tiny">${nf(p.ae_a)} in A</div>` : ""}</td>
        <td class="num">${p.ha_per_ae === null ? "—" : nf(p.ha_per_ae, 1)}</td>
        <td class="num">${nf(p.ae_year)}${u.pct !== null ? `<div class="${u.cls} tiny">${u.pct}%</div>` : ""}</td>
        <td class="num">${p.ae_now ? nf(p.ae_now) : '<span class="muted">—</span>'}</td>
      </tr>
      <tr class="condrow" id="cond-${p.paddock_id}" hidden><td colspan="7">
        <div class="row4">
          ${["a", "b", "c", "d"].map((k) => `<div class="f"><label for="c${k}-${p.paddock_id}">${k.toUpperCase()} condition, %</label>
            <input type="number" min="0" max="100" step="5" id="c${k}-${p.paddock_id}" value="${p.condition[k]}"></div>`).join("")}
        </div>
        <div class="btns"><button class="btn" data-cancel="${p.paddock_id}">Cancel</button><button class="btn primary" data-save="${p.paddock_id}">Save</button></div>
      </td></tr>`;
    };
    const pct = t.grazing.ae ? Math.round((t.ae_now / t.grazing.ae) * 100) : null;
    d.innerHTML = `
      <div class="dlg wide report">
        <header>
          <h2>Carrying capacity by paddock</h2>
          <div class="muted small">FORAGE long-term carrying capacity${r.report_date ? `, report of ${day(r.report_date)}` : ""}.</div>
        </header>
        <div class="body">
          <p class="small">Grazing paddocks can carry about <b>${nf(t.grazing.ae)} AE</b> long-term${t.grazing.ae !== t.grazing.ae_a ? ` (${nf(t.grazing.ae_a)} if all in A condition)` : ""}.
            On the place now: <b>${nf(t.ae_now)} AE</b>${pct !== null ? ` — <span class="${pct > 110 ? "bad" : ""}">${pct}%</span> of that` : ""}.
            Over the last 12 months the grazing paddocks carried <b>${nf(t.grazing.ae_year)} AE</b> on average.
            ${t.all.ae !== t.grazing.ae ? `<span class="muted">With the cultivation paddocks, ${nf(t.all.ae)} AE.</span>` : ""}</p>
          <table class="list"><thead><tr>
            <th>Paddock</th><th>Main land types</th><th>Condition</th><th class="num">Capacity, AE</th><th class="num">ha / AE</th>
            <th class="num">Carried, last 12 months</th><th class="num">AE now</th></tr></thead>
            <tbody>${r.paddocks.map(row).join("")}</tbody></table>
          <p class="muted tiny">Capacity is FORAGE's long-term carrying capacity: the AE a paddock can run year in, year out at a safe use of its median pasture growth, by land type.
            Condition lowers it as FORAGE does: B carries 75% of A, C 45%, D 20%. FORAGE assumes A until you set it${ctx.canEdit ? " — click a paddock's condition to change it" : ""}.
            Carried: average AE in the paddock over the last 12 months (each mob's AE from its weight, spread by area where gates are open);
            the % is of its capacity, red over 110% (not for cultivation, where a crop is meant to carry more). A paddock in a rotation carries well over its capacity while grazed and nothing while resting, so it's the year's average that counts.
            The rotation planner counts a rest on poorer country (more ha to the AE than the middle of the farm) for less, as its pasture grows back more slowly.</p>
        </div>
        <footer class="btns"><button class="btn" id="ccClose">Close</button><button class="btn" id="ccPrint">Print</button></footer>
      </div>`;
    d.querySelector("#ccClose").onclick = () => d.close();
    d.querySelector("#ccPrint").onclick = () => {
      document.body.classList.add("printing-report");
      window.print();
      setTimeout(() => document.body.classList.remove("printing-report"), 500);
    };
    d.querySelectorAll("[data-cond]").forEach((b) => {
      b.onclick = () => { d.querySelector(`#cond-${b.dataset.cond}`).hidden = false; };
    });
    d.querySelectorAll("[data-cancel]").forEach((b) => {
      b.onclick = () => { d.querySelector(`#cond-${b.dataset.cancel}`).hidden = true; };
    });
    d.querySelectorAll("[data-save]").forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.save;
        const v = (k) => d.querySelector(`#c${k}-${id}`).value;
        try {
          await send("PUT", `/api/pasture/capacity/${id}/condition`, { a: v("a"), b: v("b"), c: v("c"), d: v("d") });
          await load();
        } catch (e) {
          ctx.toast(e.message, { error: true });
        }
      };
    });
  };
  load();
}
