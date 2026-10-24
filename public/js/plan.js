/**
 * The rotation planner: for each mob, how long it can stay where it is, when
 * it should move (feed down to the residual, or the longest stay reached),
 * and the best paddocks to move it to — with the reasons. Most urgent first;
 * each mob's suggestion is a paddock no more urgent mob has been given.
 * Suggestions only: moves are still recorded from the mob as usual.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
const nf = (n) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: 0 });

export async function openPlan(ctx) {
  const d = ctx.dialog;
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Working out the plan… (the pasture model takes a few seconds)</p></div></div>';
  if (!d.open) d.showModal();
  let p;
  try {
    p = await get("/api/plan");
  } catch (e) {
    d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!p.ok) {
    d.querySelector(".body").innerHTML = `<p>${escapeHtml(p.reason)}</p><div class="btns"><button class="btn" id="plClose">Close</button></div>`;
    d.querySelector("#plClose").onclick = () => d.close();
    return;
  }
  const r = p.rules;
  const optRow = (o, chosen) => `<tr${chosen ? ' class="chosen"' : ""}>
    <td>${chosen ? "<b>" : ""}${escapeHtml(o.name)}${chosen ? "</b>" : ""}${o.adjacent ? ' <span class="chip" title="Through a gate from where it is now">next door</span>' : ""}
      <div class="muted tiny">${nf(o.area_ha)} ha · reading ${o.reading ? escapeHtml(o.reading) : "—"}</div></td>
    <td class="num">${nf(o.now)}</td>
    <td class="num"><b>${o.stay}</b>${o.days.median > r.max_days ? "+" : ""}${o.days.low < o.days.median ? ` <span class="muted tiny">(dry ${o.days.low})</span>` : ""}</td>
    <td class="num">${o.rest_days === null ? '<span class="muted">—</span>' : o.rest_days}</td></tr>`;

  d.innerHTML = `
    <div class="dlg wide report">
      <header>
        <h2>Rotation planner</h2>
        <div class="muted small">Weather to ${escapeHtml(p.as_of)}. Leave at least <b>${nf(r.residual)} kg/ha</b>; stay <b>${r.min_days}–${r.max_days} days</b> in a paddock.
          ${ctx.canEdit ? '<button class="linkbtn" id="plRules">Change</button>' : ""}</div>
      </header>
      <div class="body">
        <div id="plRulesBox" hidden>
          <div class="row2">
            <div class="f"><label for="plRes">Residual, kg/ha</label><input id="plRes" type="number" step="50" value="${r.residual}"></div>
            <div class="f"><label for="plMin">Shortest stay, days</label><input id="plMin" type="number" value="${r.min_days}"></div>
          </div>
          <div class="row2">
            <div class="f"><label for="plMax">Longest stay, days</label><input id="plMax" type="number" value="${r.max_days}"></div>
            <div class="f"><label>&nbsp;</label><button class="btn primary" id="plSave">Save and replan</button></div>
          </div>
        </div>
        ${p.mobs.map((m) => `
          <section class="planmob">
            <h3>${escapeHtml(m.mob)} <span class="muted small">· ${m.mobs > 1 ? `${m.mobs} mobs together, ` : ""}${nf(m.head)} hd, ${nf(m.ae)} AE${m.owner ? ` · ${escapeHtml(m.owner)}` : ""}</span></h3>
            <p class="small">In <b>${escapeHtml(m.paddocks.join(" + "))}</b>${m.in_since ? ` since ${day(m.in_since)} (${m.days_in} days)` : ""}${m.now !== null ? ` · ${nf(m.now)} kg/ha now` : ""}.
              ${m.move_in <= 0 ? '<b class="bad">Move now</b>' : `Move by <b>${day(m.move_by)}</b> (${m.move_in} days)`}:
              ${m.why === "feed" ? `feed down to ${nf(r.residual)} kg/ha` : `the ${r.max_days}-day limit`}.
              ${m.notes.length ? `<span class="muted">${m.notes.map(escapeHtml).join("; ")}.</span>` : ""}</p>
            ${m.options.length ? `
            <table class="list"><thead><tr><th>Next paddock</th><th class="num">kg/ha now</th><th class="num">Days of feed</th><th class="num">Rested, days</th></tr></thead><tbody>
              ${m.suggested ? optRow(m.suggested, true) : ""}
              ${m.options.filter((o) => !m.suggested || o.paddock_id !== m.suggested.paddock_id).slice(0, 4).map((o) => optRow(o, false)).join("")}
            </tbody></table>
            ${!m.suggested ? '<p class="small bad">Every paddock with a week of feed is already taken by a more urgent mob.</p>' : ""}`
            : `<p class="small bad">No empty paddock has ${r.min_days} days of feed for this mob above ${nf(r.residual)} kg/ha.</p>`}
          </section>`).join("")}
        <p class="muted tiny">Days of feed: until the paddock is grazed down to the residual by this mob, with growth from today's soil water across past seasons — the median, and a drier run in brackets. Capped at the longest stay ("+" means more feed than that). Bold is the suggestion: the most urgent mob gets its best paddock first. Rested: days since the paddock was last grazed. Only empty paddocks with pasture readings are offered.</p>
      </div>
      <footer class="btns"><button class="btn" id="plClose">Close</button></footer>
    </div>`;
  d.querySelector("#plClose").onclick = () => d.close();
  const rb = d.querySelector("#plRules");
  if (rb) rb.onclick = () => { d.querySelector("#plRulesBox").hidden = false; };
  const sv = d.querySelector("#plSave");
  if (sv) sv.onclick = async () => {
    try {
      await send("PUT", "/api/plan/rules", { residual: d.querySelector("#plRes").value, min_days: d.querySelector("#plMin").value, max_days: d.querySelector("#plMax").value });
      openPlan(ctx);
    } catch (e) {
      ctx.toast(e.message, { error: true });
    }
  };
}
