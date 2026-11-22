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

/* ------------------------------ Rotation tab ------------------------------ */

// The plan takes a few seconds (the pasture model), so the tab shows the last
// one straight away and refreshes it when it's more than a couple of minutes old.
let lastPlan = null, lastAt = 0, pending = null;

/** Two lines per paddock in use: how long the stock has been in, and where next. */
export async function renderRotation(el, ctx) {
  if (lastPlan) drawRotation(el, ctx, lastPlan);
  if (lastPlan && Date.now() - lastAt < 120_000) return;
  if (!lastPlan) el.innerHTML = '<p class="muted small">Working out the plan… (the pasture model takes a few seconds)</p>';
  // The panel redraws often while the app loads: share one request between them.
  if (!pending) pending = get("/api/plan").finally(() => { pending = null; });
  let p;
  try {
    p = await pending;
  } catch (e) {
    if (!lastPlan && el.isConnected) el.innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    return;
  }
  lastPlan = p; lastAt = Date.now();
  // Draw into whichever copy of the tab is on screen now.
  const live = el.isConnected ? el : document.getElementById("rotationTab");
  if (live) drawRotation(live, ctx, p);
}

/** Forget the cached plan, e.g. after a move, so the tab works it out again. */
export function forgetRotation() { lastPlan = null; lastAt = 0; }

function drawRotation(el, ctx, p) {
  if (!p.ok) { el.innerHTML = `<p class="muted small">${escapeHtml(p.reason)}</p>`; return; }
  const r = p.rules;
  const days = (n) => `${nf(n)} day${n === 1 ? "" : "s"}`;
  const padLinks = (m) => m.paddocks.map((name, i) => m.paddock_ids?.[i] != null
    ? `<button class="linkbtn strong" data-pad="${m.paddock_ids[i]}">${escapeHtml(name)}</button>` : `<b>${escapeHtml(name)}</b>`).join(" + ");
  const due = (m) => (m.move_in <= 0
    ? '<b class="bad">move now</b>'
    : `move by <b${m.move_in <= 3 ? ' class="warnc"' : ""}>${day(m.move_by)}</b>`);
  const next = (m) => {
    const o = m.suggested;
    if (!o) return `<span class="bad">${m.options.length ? "Every paddock with feed is taken by a more urgent mob" : `No empty paddock has ${r.min_days} days of feed`}</span>`;
    const bits = [`${nf(o.stay)}${o.days.median > r.max_days ? "+" : ""} days of feed`];
    bits.push(o.rest_days === null ? "rest unknown" : `rested ${days(o.rest_days)}`);
    if (o.adjacent) bits.push("next door");
    return `Next → <button class="linkbtn strong" data-why="${p.mobs.indexOf(m)}:${o.paddock_id}" title="Why this paddock?">${escapeHtml(o.name)} ⓘ</button> <span class="muted">· ${bits.join(" · ")}</span>`;
  };
  el.innerHTML = `
    ${p.mobs.length ? `<ul class="rotlist">${p.mobs.map((m) => `
      <li>
        <div>${padLinks(m)} · ${m.mob_ids.length === 1 ? `<button class="linkbtn" data-mob="${m.mob_ids[0]}">${nf(m.head)} hd</button>` : `${nf(m.head)} hd`}
          · in <b>${days(m.days_in)}</b> · ${due(m)}
          <div class="muted tiny">${escapeHtml(m.mob)}${m.owner ? ` · ${escapeHtml(m.owner)}` : ""}${m.in_since ? ` · since ${day(m.in_since)}` : ""}</div></div>
        <div class="small">${next(m)}</div>
      </li>`).join("")}</ul>` : '<p class="muted small">No stock in paddocks.</p>'}
    ${p.unplanned?.length ? `<p class="small muted">Not planned (in a holding area, not a paddock): ${p.unplanned.map((u) => `${escapeHtml(u.mob)} (${u.head} hd, ${escapeHtml(u.where)})`).join("; ")}.</p>` : ""}
    <div class="btns"><button class="btn" id="rotFull">Full planner: other options and why…</button></div>
    <p class="muted tiny">Most urgent first. Leave ${nf(r.residual)} kg/ha, stay ${r.min_days}–${r.max_days} days (change these in the full planner). Weather to ${escapeHtml(p.as_of)}. Suggestions only: move cattle from the mob's page or by dragging its icon on the map.</p>`;
  el.querySelectorAll("[data-pad]").forEach((b) => { b.onclick = () => ctx.select(Number(b.dataset.pad), { zoom: true }); });
  el.querySelectorAll("[data-mob]").forEach((b) => { b.onclick = () => ctx.selectMob(Number(b.dataset.mob)); });
  el.querySelector("#rotFull").onclick = () => openPlan(ctx);
  bindWhy(el, ctx, p, null);
}

/** Buttons marked data-why="mobIndex:paddockId" open the explanation for that option. */
function bindWhy(root, ctx, p, back) {
  root.querySelectorAll("[data-why]").forEach((b) => {
    b.onclick = () => {
      const [mi, pid] = b.dataset.why.split(":").map(Number);
      explain(ctx, p, mi, pid, back);
    };
  });
}

const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const ageDays = (d) => Math.round((Date.now() - Date.parse(`${d}T00:00:00`)) / 86_400_000);

/**
 * How a suggestion came about: the feed and how long it lasts, the Cibo
 * reading behind it, the rain and soil water that grow it, the rest, and how
 * it scored against the other paddocks this mob could go to.
 */
function explain(ctx, p, mi, pid, back) {
  const d = ctx.dialog;
  const m = p.mobs[mi];
  const o = m?.options.find((x) => x.paddock_id === pid);
  if (!o) return;
  const r = p.rules;
  const f = o.facts || {};
  const chosen = m.suggested?.paddock_id === pid;
  // Paddocks other mobs were given first (the most urgent mob chooses first).
  const takenBy = new Map(p.mobs.filter((x) => x !== m && x.suggested).map((x) => [x.suggested.paddock_id, x.mob]));
  const aeHa = o.area_ha ? m.ae / o.area_ha : null;
  const capped = o.days.median > r.max_days;
  const rd = f.reading;
  const age = rd ? ageDays(rd.date) : null;
  const diff = rd ? o.now - rd.tsdm : null;
  const mm = (n) => `${nf(n)} mm`;
  const rain30 = f.rain_30_median != null
    ? `${mm(f.rain_30)} in the last 30 days, against ${mm(f.rain_30_median)} in a normal year for this time (the median since 1890)${f.rain_30 >= f.rain_30_median * 1.25 ? ", so wetter than usual" : f.rain_30 <= f.rain_30_median * 0.75 ? ", so drier than usual" : ""}.`
    : `${mm(f.rain_30)} in the last 30 days.`;
  const ranked = [...m.options].sort((a, b) => b.score - a.score);
  const place = ranked.findIndex((x) => x.paddock_id === pid) + 1;

  d.innerHTML = `
    <div class="dlg wide report">
      <header>
        <h2>${chosen ? "Why" : "About"} ${escapeHtml(o.name)} for the stock in ${escapeHtml(m.paddocks.join(" + "))}</h2>
        <div class="muted small">${nf(m.head)} hd, ${nf(m.ae)} AE (${escapeHtml(m.mob)}), ${m.move_in <= 0 ? "due to move now" : `move by ${day(m.move_by)}`}.</div>
      </header>
      <div class="body why">
        <p>${chosen
          ? `<b>${escapeHtml(o.name)}</b> scored highest of the ${m.options.length} paddock${m.options.length === 1 ? "" : "s"} with at least ${r.min_days} days of feed for this mob${ranked[0].paddock_id !== pid ? " that weren't already given to a more urgent mob" : ""}.`
          : `<b>${escapeHtml(o.name)}</b> came ${place}${["st", "nd", "rd"][place - 1] || "th"} of ${m.options.length} for this mob${takenBy.has(pid) ? `, and it's already suggested for <b>${escapeHtml(takenBy.get(pid))}</b>, a more urgent mob` : ""}.`}
          Score <b>${o.score}</b> = ${o.parts.feed} for days of feed + ${o.parts.rest} for rest${o.parts.next_door ? " + 5 for being next door" : ""}.</p>
        ${(() => { const ties = m.options.filter((x) => x.paddock_id !== pid && x.score === o.score).length;
          return ties ? `<p class="note warn">Tied on ${o.score} with ${ties} other paddock${ties === 1 ? "" : "s"}: they all have more feed than the ${r.max_days}-day limit and long rests, so the planner can't tell them apart and the pick between them is arbitrary. Treat them as equally good.</p>` : ""; })()}

        <h3>Time: how long the feed lasts</h3>
        <p>About <b>${nf(o.now)} kg/ha</b> there today${f.now_green != null ? ` (${nf(f.now_green)} of it green)` : ""}, on ${nf(o.area_ha)} ha.
          With ${nf(m.ae)} AE that's ${aeHa != null ? `${aeHa.toFixed(2)} AE/ha` : "—"}, each eating about 8 kg of dry matter a day, while the pasture keeps growing with the weather.
          It lasts until it's grazed down to ${nf(r.residual)} kg/ha: <b>${capped ? `more than ${r.max_days}` : nf(o.days.median)} days</b> in a typical season${o.days.low < o.days.median ? `, ${nf(o.days.low)} in a drier one` : ""}.
          ${capped ? `Counted as ${r.max_days}, your longest stay.` : ""}</p>

        <h3>Pasture: Cibo PastureKey</h3>
        ${rd ? `<p>Last reading <b>${fmtDay(rd.date)}</b>: ${nf(rd.tsdm)} kg/ha${rd.green != null ? ` (${nf(rd.green)} green)` : ""}, ${nf(age)} days ago.
          Since then the model has grown and grazed it day by day with the actual rain and weather, giving ${nf(o.now)} kg/ha today (${diff >= 0 ? "+" : "−"}${nf(Math.abs(diff))}).</p>
          ${age > 21 ? `<p class="note warn">That reading is ${nf(age)} days old, so today's figure leans on the model more than usual. New PastureKey readings would firm it up.</p>` : ""}`
          : '<p class="muted">No PastureKey reading for this paddock.</p>'}
        ${f.multiplier != null ? `<p class="small muted">This paddock grows about ${f.multiplier.toFixed(2)}× the district average, fitted from its past Cibo readings (soil, land condition, cultivation).</p>` : ""}

        <h3>Rain and soil water: SILO (Long Paddock)</h3>
        <ul class="small">
          ${rd && f.rain_since_reading != null ? `<li>${mm(f.rain_since_reading)} since the Cibo reading on ${fmtDay(rd.date)}.</li>` : ""}
          <li>${rain30}</li>
          <li>Soil water now: <b>${nf(f.soil_water_pct)}% full</b>. Growth starts from this.</li>
          ${f.rain_ahead ? `<li>The next ${f.rain_ahead.days} days, in past seasons from this date: ${mm(f.rain_ahead.median)} in a typical one, ${mm(f.rain_ahead.low)} in a drier one. The days of feed above come from running all ${p.seasons || "the"} past seasons forward.</li>` : ""}
        </ul>
        <p class="muted tiny">SILO weather to ${fmtDay(p.as_of)}, at the grid point for this paddock.</p>

        <h3>Rest</h3>
        <p>${o.rest_days === null ? "No grazing recorded here since records began, so it's counted as a 60-day rest."
          : `Last grazed <b>${nf(o.rest_days)} days ago</b>.`}
          ${o.rest_days !== null && o.rest_weight < 1 ? ` This is poorer country (FORAGE carrying capacity), where pasture grows back more slowly, so the rest counts as ${nf(o.rest_counts)} days.` : ""}
          Rest adds up to 12 points (a tenth of the days, capped at 120).</p>

        <h3>Where it is</h3>
        <p>${o.adjacent ? `Through a gate from ${escapeHtml(m.paddocks.join(" + "))}, so a short walk (+5).` : `Not next door to ${escapeHtml(m.paddocks.join(" + "))}.`}</p>

        <h3>How it compared</h3>
        <table class="list"><thead><tr><th>Paddock</th><th class="num">Feed</th><th class="num">Rest</th><th class="num">Next door</th><th class="num">Score</th></tr></thead><tbody>
          ${ranked.map((x) => `<tr${x.paddock_id === pid ? ' class="chosen"' : ""}>
            <td><button class="linkbtn${x.paddock_id === pid ? " strong" : ""}" data-why="${mi}:${x.paddock_id}">${escapeHtml(x.name)}</button>${m.suggested?.paddock_id === x.paddock_id ? ' <span class="chip">suggested</span>' : takenBy.has(x.paddock_id) ? `<div class="muted tiny">given to ${escapeHtml(takenBy.get(x.paddock_id))}</div>` : ""}</td>
            <td class="num">${x.parts.feed}</td><td class="num">${x.parts.rest}</td><td class="num">${x.parts.next_door || ""}</td><td class="num"><b>${x.score}</b></td></tr>`).join("")}
        </tbody></table>
        <p class="muted tiny">Only empty paddocks with at least ${r.min_days} days of feed are offered; the top six are shown.</p>
      </div>
      <footer class="btns">
        ${back ? '<button class="btn" id="whyBack">← Back to the planner</button>' : ""}
        <button class="btn" id="whyMap">Show ${escapeHtml(o.name)} on the map</button>
        <button class="btn primary" id="whyClose">Close</button>
      </footer>
    </div>`;
  if (!d.open) d.showModal();
  d.querySelector("#whyClose").onclick = () => d.close();
  d.querySelector("#whyMap").onclick = () => { d.close(); ctx.select(pid, { zoom: true }); };
  if (back) d.querySelector("#whyBack").onclick = back;
  bindWhy(d, ctx, p, back);
  d.querySelector(".body").scrollTop = 0;
}

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
  const optRow = (o, chosen, mi) => `<tr${chosen ? ' class="chosen"' : ""}>
    <td><button class="linkbtn${chosen ? " strong" : ""}" data-why="${mi}:${o.paddock_id}" title="How this was worked out">${escapeHtml(o.name)}</button>${o.adjacent ? ' <span class="chip" title="Through a gate from where it is now">next door</span>' : ""}
      <div class="muted tiny">${nf(o.area_ha)} ha · reading ${o.reading ? escapeHtml(o.reading) : "—"}</div></td>
    <td class="num">${nf(o.now)}</td>
    <td class="num"><b>${o.stay}</b>${o.days.median > r.max_days ? "+" : ""}${o.days.low < o.days.median ? ` <span class="muted tiny">(dry ${o.days.low})</span>` : ""}</td>
    <td class="num">${o.rest_days === null ? '<span class="muted">—</span>' : o.rest_days}${o.rest_days !== null && o.rest_weight < 1 ? `<div class="muted tiny" title="Poorer country: its pasture grows back more slowly, so a rest here counts for less">counts as ${o.rest_counts}</div>` : ""}</td></tr>`;

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
        ${p.mobs.map((m, mi) => `
          <section class="planmob">
            <h3>${escapeHtml(m.mob)} <span class="muted small">· ${m.mobs > 1 ? `${m.mobs} mobs together, ` : ""}${nf(m.head)} hd, ${nf(m.ae)} AE${m.owner ? ` · ${escapeHtml(m.owner)}` : ""}</span></h3>
            <p class="small">In <b>${escapeHtml(m.paddocks.join(" + "))}</b>${m.in_since ? ` since ${day(m.in_since)} (${m.days_in} days)` : ""}${m.now !== null ? ` · ${nf(m.now)} kg/ha now` : ""}.
              ${m.move_in <= 0 ? '<b class="bad">Move now</b>' : `Move by <b>${day(m.move_by)}</b> (${m.move_in} days)`}:
              ${m.why === "feed" ? `feed down to ${nf(r.residual)} kg/ha` : `the ${r.max_days}-day limit`}.
              ${m.notes.length ? `<span class="muted">${m.notes.map(escapeHtml).join("; ")}.</span>` : ""}</p>
            ${m.options.length ? `
            <table class="list"><thead><tr><th>Next paddock</th><th class="num">kg/ha now</th><th class="num">Days of feed</th><th class="num">Rested, days</th></tr></thead><tbody>
              ${m.suggested ? optRow(m.suggested, true, mi) : ""}
              ${m.options.filter((o) => !m.suggested || o.paddock_id !== m.suggested.paddock_id).slice(0, 4).map((o) => optRow(o, false, mi)).join("")}
            </tbody></table>
            ${!m.suggested ? '<p class="small bad">Every paddock with a week of feed is already taken by a more urgent mob.</p>' : ""}`
            : `<p class="small bad">No empty paddock has ${r.min_days} days of feed for this mob above ${nf(r.residual)} kg/ha.</p>`}
          </section>`).join("")}
        ${p.unplanned?.length ? `<p class="small muted">Not planned (in a management-only or holding area, not a paddock): ${p.unplanned.map((u) => `${escapeHtml(u.mob)} (${u.head} hd, ${escapeHtml(u.where)})`).join("; ")}.</p>` : ""}
        <p class="muted tiny">Days of feed: until the paddock is grazed down to the residual by this mob, with growth from today's soil water across past seasons — the median, and a drier run in brackets. Capped at the longest stay ("+" means more feed than that). Bold is the suggestion: the most urgent mob gets its best paddock first. Rested: days since the paddock was last grazed; on poorer country (FORAGE's carrying capacity) a rest counts for less, as shown under it. Only empty paddocks with pasture readings are offered.</p>
      </div>
      <footer class="btns"><button class="btn" id="plClose">Close</button></footer>
    </div>`;
  d.querySelector("#plClose").onclick = () => d.close();
  bindWhy(d, ctx, p, () => openPlan(ctx));
  const rb = d.querySelector("#plRules");
  if (rb) rb.onclick = () => { d.querySelector("#plRulesBox").hidden = false; };
  const sv = d.querySelector("#plSave");
  if (sv) sv.onclick = async () => {
    try {
      await send("PUT", "/api/plan/rules", { residual: d.querySelector("#plRes").value, min_days: d.querySelector("#plMin").value, max_days: d.querySelector("#plMax").value });
      forgetRotation();
      openPlan(ctx);
    } catch (e) {
      ctx.toast(e.message, { error: true });
    }
  };
}
