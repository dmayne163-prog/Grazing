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

const FEED_HORIZON = 120; // as the server projects (src/pasture/plan.ts)
const feedDays = (o) => (o.days.median >= FEED_HORIZON ? `${FEED_HORIZON}+` : nf(o.days.median));
const walkText = (n) => (n === 1 ? "next door" : `${n} gates away`);

// The server keeps the plan worked out ahead, so asking is quick; the tab still
// shows the last one straight away (kept on this device too, for when the app
// opens) and checks for a newer one when it's more than a couple of minutes old.
const KEEP = "grazing.lastPlan";
let lastPlan = (() => { try { return JSON.parse(localStorage.getItem(KEEP) || "null"); } catch { return null; } })();
let lastAt = 0, pending = null;

/** When the plan was last worked out, as "today 9:15 am" or "Mon 23 Nov". */
function workedOut(ms) {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? `today ${t}` : d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

/** Two lines per paddock in use: how long the stock has been in, and where next. */
export async function renderRotation(el, ctx) {
  if (lastPlan) drawRotation(el, ctx, lastPlan);
  if (lastPlan && Date.now() - lastAt < 120_000) return;
  if (!lastPlan) el.innerHTML = '<p class="muted small">Getting the plan…</p>';
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
  try { localStorage.setItem(KEEP, JSON.stringify(p)); } catch { /* private window: fine */ }
  // Draw into whichever copy of the tab is on screen now.
  const live = el.isConnected ? el : document.getElementById("rotationTab");
  if (live) drawRotation(live, ctx, p);
}

/** The plan for the map layer: the one kept here if it's fresh, else asked for. */
export async function getPlan() {
  if (lastPlan && Date.now() - lastAt < 120_000) return lastPlan;
  if (!pending) pending = get("/api/plan").finally(() => { pending = null; });
  try {
    const p = await pending;
    lastPlan = p; lastAt = Date.now();
    try { localStorage.setItem(KEEP, JSON.stringify(p)); } catch { /* fine */ }
    return p;
  } catch (e) {
    if (lastPlan) return lastPlan;
    throw e;
  }
}

/** Forget the cached plan, e.g. after a move, so the tab works it out again. */
export function forgetRotation() { lastPlan = null; lastAt = 0; try { localStorage.removeItem(KEEP); } catch { /* fine */ } }

function drawRotation(el, ctx, p) {
  if (!p.ok) { el.innerHTML = `<p class="muted small">${escapeHtml(p.reason)}</p>`; return; }
  const r = p.rules;
  const days = (n) => `${nf(n)} day${n === 1 ? "" : "s"}`;
  const padLinks = (m) => m.paddocks.map((name, i) => m.paddock_ids?.[i] != null
    ? `<button class="linkbtn strong" data-pad="${m.paddock_ids[i]}">${escapeHtml(name)}</button>` : `<b>${escapeHtml(name)}</b>`).join(" + ");
  const due = (m) => (m.leaving?.stays ? `leaves <b>${day(m.leaving.date)}</b>`
    : m.move_in <= 0
    ? '<b class="bad">move now</b>'
    : `move by <b${m.move_in <= 3 ? ' class="warnc"' : ""}>${day(m.move_by)}</b>`);
  const next = (m) => {
    const lv = m.leaving;
    if (lv?.stays) return `Stays until ${lv.head_staying ? `${nf(lv.head_leaving)} hd leave` : "it leaves"} on <b>${day(lv.date)}</b>${lv.note ? ` (${escapeHtml(lv.note)})` : ""}, then off from ${escapeHtml(lv.yards || "the yards")}${lv.yards_hops_now ? ` <span class="muted">· ${walkText(lv.yards_hops_now).replace("next door", "next to the yards")}${lv.yards_hops_now > 1 ? " from the yards" : ""}</span>` : lv.yards_hops_now === null && lv.yards ? ' <span class="muted">· more than 3 gates from the yards</span>' : ""}`;
    const o = m.suggested;
    if (!o) return `<span class="bad">${m.options.length ? "Every paddock with feed is taken by a more urgent mob" : `No empty paddock has ${r.min_days} days of feed`}</span>`;
    const bits = [`${feedDays(o)} days of feed`];
    bits.push(o.rest_days === null ? "rest unknown" : `rested ${days(o.rest_days)}`);
    if (o.gates_away) bits.push(walkText(o.gates_away));
    if (lv?.last) {
      bits[0] = `needs ${days(lv.need)} of feed, has ${feedDays(o)}`;
      bits.push(o.yards_access === "easy" ? `easy to ${escapeHtml(lv.yards || "the yards")}` : o.yards_access === "hard" ? "hard muster" : o.yards_hops ? `${o.yards_hops === 1 ? "next to" : `${o.yards_hops} gates from`} ${escapeHtml(lv.yards || "the yards")}` : `${o.yards_km != null ? `${o.yards_km} km` : "far"} from ${escapeHtml(lv.yards || "the yards")}`);
    }
    return `${lv?.last ? `Last paddock before it leaves ${day(lv.date)} → ` : "Next → "}<button class="linkbtn strong" data-why="${p.mobs.indexOf(m)}:${o.paddock_id}" title="Why this paddock?">${escapeHtml(o.name)} ⓘ</button> <span class="muted">· ${bits.join(" · ")}</span>`;
  };
  el.innerHTML = `
    ${p.mobs.length ? `<ul class="rotlist">${p.mobs.map((m) => `
      <li>
        <div>${padLinks(m)} · ${m.mob_ids.length === 1 ? `<button class="linkbtn" data-mob="${m.mob_ids[0]}">${nf(m.head)} hd</button>` : `${nf(m.head)} hd`}
          · in <b>${days(m.days_in)}</b> · ${due(m)}
          <div class="muted tiny">${escapeHtml(m.mob)}${m.owner ? ` · ${escapeHtml(m.owner)}` : ""}${m.in_since ? ` · since ${day(m.in_since)}` : ""}${m.leaving ? ` · <b>${m.leaving.head_staying ? `${nf(m.leaving.head_leaving)} hd ` : ""}leaving ${day(m.leaving.date)}${m.leaving.note ? ` (${escapeHtml(m.leaving.note)})` : ""}</b>` : ""}${m.notes?.length ? ` · ${m.notes.map(escapeHtml).join("; ")}` : ""}</div></div>
        <div class="small">${next(m)}</div>
        ${m.pattern?.length > 1 ? `<div class="muted tiny">Then: ${m.pattern.slice(1).map((s) => `${escapeHtml(s.name)} ${day(s.from)}`).join(" → ")}</div>` : ""}
        ${m.rotation ? `<div class="muted tiny">Rotates around ${m.rotation.names.map(escapeHtml).join(", ")}${m.rotation.outside ? ' · <b class="warnc">none free with feed: suggesting outside it</b>' : ""}${m.short_from ? ` · <b class="warnc">no other paddock in it has enough feed for this mob by ${day(m.short_from)}</b>` : ""}</div>` : ""}
      </li>`).join("")}</ul>` : '<p class="muted small">No stock in paddocks.</p>'}
    ${p.not_ready?.length ? `<p class="small">Crops not ready to graze yet (only suggested for a mob moving on or after the day they're ready): ${p.not_ready.map((c) => `<button class="linkbtn strong" data-pad="${c.paddock_id}">${escapeHtml(c.name)}</button> <span class="muted">(${escapeHtml(c.crop)}, planted ${day(c.sown_on)})</span> ready <b>${day(c.ready_on)}</b>`).join("; ")}.</p>` : ""}
    ${p.unplanned?.length ? `<p class="small muted">Not planned (in a holding area, not a paddock): ${p.unplanned.map((u) => `${escapeHtml(u.mob)} (${u.head} hd, ${escapeHtml(u.where)})`).join("; ")}.</p>` : ""}
    <div class="btns"><button class="btn" id="rotFull">Full planner: other options and why…</button></div>
    <p class="muted tiny">Most urgent first. Leave ${nf(r.residual)} kg/ha, stay ${r.min_days}–${r.max_days} days (change these in the full planner). Weather to ${escapeHtml(p.as_of)}.${p.worked_out ? ` Worked out ${workedOut(p.worked_out)}, and again when cattle are moved, Cibo readings come in, or once a week.` : ""} Suggestions only: move cattle from the mob's page or by dragging its icon on the map.</p>`;
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
  const rd = f.reading;
  const age = rd ? ageDays(rd.date) : null;
  const diff = rd ? o.now - rd.tsdm : null;
  const mm = (n) => `${nf(n)} mm`;
  const days = (n) => `${nf(n)} day${n === 1 ? "" : "s"}`;
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
          Score <b>${o.score}</b> = ${o.parts.feed} feed + ${o.parts.margin} spare feed + ${o.parts.green} green + ${o.parts.rest} rest${o.parts.walk ? ` + ${o.parts.walk} walk` : ""}${o.parts.yards ? ` + ${o.parts.yards} near the yards` : ""}.</p>
        ${m.leaving?.last ? `<p class="note">This mob is booked to leave on <b>${day(m.leaving.date)}</b>${m.leaving.note ? ` (${escapeHtml(m.leaving.note)})` : ""} from ${escapeHtml(m.leaving.yards || "the yards")}. It has to move from ${escapeHtml(m.paddocks.join(" + "))} by ${day(m.move_by)}, so this paddock only needs <b>${days(m.leaving.need)}</b> of feed. Spare feed doesn't count, and being close to the yards counts most: next to them adds 20, two gates away 12, three 6.</p>` : ""}
        ${o.confidence < 100 ? `<p class="note warn">The Cibo reading is ${nf(o.reading_age)} days old, so the three parts that rely on the pasture model (feed, spare feed, green) are counted at <b>${o.confidence}%</b>. Rest and the walk count in full, so they carry more weight until new readings come in.</p>` : ""}
        ${(() => { const ties = m.options.filter((x) => x.paddock_id !== pid && x.score === o.score).length;
          return ties ? `<p class="note warn">Tied on ${o.score} with ${ties} other paddock${ties === 1 ? "" : "s"}: they score the same on every count, so the planner can't tell them apart and the pick between them is arbitrary. Treat them as equally good.</p>` : ""; })()}

        <h3>Time: how long the feed lasts</h3>
        <p>About <b>${nf(o.now)} kg/ha</b> there today${f.now_green != null ? ` (${nf(f.now_green)} of it green)` : ""}, on ${nf(o.area_ha)} ha.
          With ${nf(m.ae)} AE that's ${aeHa != null ? `${aeHa.toFixed(2)} AE/ha` : "—"}, each eating about 8 kg of dry matter a day, while the pasture keeps growing with the weather.
          It lasts until it's grazed down to ${nf(r.residual)} kg/ha: <b>${feedDays(o)} days</b> in a typical season and <b>${o.days.low >= FEED_HORIZON ? `${FEED_HORIZON}+` : nf(o.days.low)} days</b> in a drier one (the driest fifth of past seasons).</p>
        ${m.leaving?.last ? `<ul class="small">
          <li><b>Feed (${o.parts.feed}):</b> lasting the ${days(m.leaving.need)} until it leaves, even in a drier season, adds up to 20.</li>
          <li><b>Near the yards (${o.parts.yards}):</b> ${o.yards_access === "easy" ? `marked as an easy muster to the yards (a laneway or close by)` : o.yards_access === "hard" ? `marked as a hard muster (timbered or long), so it gets nothing here` : o.yards_hops === 1 ? `its fence is within 150 m of ${escapeHtml(m.leaving.yards || "the yards")}` : o.yards_hops ? `${o.yards_hops} gates from a paddock next to ${escapeHtml(m.leaving.yards || "the yards")}` : `more than three gates from ${escapeHtml(m.leaving.yards || "the yards")}`}${o.yards_km ? ` (${o.yards_km} km fence to fence)` : ""}.</li>
        </ul>` : `<ul class="small">
          <li><b>Feed (${o.parts.feed}):</b> days it lasts up to your ${r.max_days}-day longest stay, half from the typical season and half from the drier one, so a paddock that only lasts if it rains scores less.</li>
          <li><b>Spare feed (${o.parts.margin}):</b> each day of typical-season feed past ${r.max_days} days counts a quarter, up to ${FEED_HORIZON} days. It's a safety margin if it turns dry.</li>
        </ul>`}

        <h3>Pasture: Cibo PastureKey</h3>
        ${rd ? `<p>Last reading <b>${fmtDay(rd.date)}</b>: ${nf(rd.tsdm)} kg/ha${rd.green != null ? ` (${nf(rd.green)} green)` : ""}, ${nf(age)} days ago.
          Since then the model has grown and grazed it day by day with the actual rain and weather, giving ${nf(o.now)} kg/ha today (${diff >= 0 ? "+" : "−"}${nf(Math.abs(diff))}).</p>
          ${age > 21 ? `<p class="note warn">That reading is ${nf(age)} days old, so today's figure leans on the model more than usual. New PastureKey readings would firm it up.</p>` : ""}`
          : '<p class="muted">No PastureKey reading for this paddock.</p>'}
        ${o.planting ? `<p class="small">Planted on ${fmtDay(o.planting.sown_on)} to ${(o.planting.crops || [{ crop: o.planting.crop, rate_kg_ha: o.planting.rate_kg_ha }]).map((c) => `<b>${escapeHtml(c.crop)}</b>${c.rate_kg_ha != null ? ` at ${c.rate_kg_ha} kg/ha` : ""}`).join(" + ")}${o.planting.fertiliser ? `, ${escapeHtml(o.planting.fertiliser)}` : ""}; ready to graze from ${fmtDay(o.planting.ready_on)}${o.planting.ready_guessed ? " (taken as 8 weeks after planting)" : ""}.</p>` : ""}
        <p><b>Green (${o.parts.green}):</b> ${o.green_share != null ? `${nf(o.green_share)}% of the feed is green today` : "green share unknown"}. Green feed is better quality, so it adds up to 15 points.</p>
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
          <b>Rest (${o.parts.rest}):</b> a tenth of the days rested, up to 12 points at 120 days.</p>

        <h3>Where it is</h3>
        <p><b>Walk (${o.parts.walk}):</b> ${o.gates_away ? `${o.gates_away === 1 ? "through one gate" : `through ${o.gates_away} gates`} from ${escapeHtml(m.paddocks.join(" + "))}` : `more than three gates from ${escapeHtml(m.paddocks.join(" + "))}, or no gate route mapped`}. One gate adds 5, two add 3, three add 1.5.</p>

        <h3>How it compared</h3>
        <table class="list"><thead><tr><th>Paddock</th><th class="num">Feed</th><th class="num">Spare</th><th class="num">Green</th><th class="num">Rest</th><th class="num">Walk</th>${m.leaving?.last ? '<th class="num">Yards</th>' : ""}<th class="num">Score</th></tr></thead><tbody>
          ${ranked.map((x) => `<tr${x.paddock_id === pid ? ' class="chosen"' : ""}>
            <td><button class="linkbtn${x.paddock_id === pid ? " strong" : ""}" data-why="${mi}:${x.paddock_id}">${escapeHtml(x.name)}</button>${m.suggested?.paddock_id === x.paddock_id ? ' <span class="chip">suggested</span>' : takenBy.has(x.paddock_id) ? `<div class="muted tiny">given to ${escapeHtml(takenBy.get(x.paddock_id))}</div>` : ""}</td>
            <td class="num">${x.parts.feed}</td><td class="num">${x.parts.margin}</td><td class="num">${x.parts.green}</td><td class="num">${x.parts.rest}</td><td class="num">${x.parts.walk || ""}</td>${m.leaving?.last ? `<td class="num">${x.parts.yards || ""}</td>` : ""}<td class="num"><b>${x.score}</b></td></tr>`).join("")}
        </tbody></table>
        <p class="muted tiny">Only empty paddocks with at least ${r.min_days} days of feed are offered, and not a crop that won't be ready to graze by ${day(m.move_by)}; the top six are shown.</p>
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
    <td><button class="linkbtn${chosen ? " strong" : ""}" data-why="${mi}:${o.paddock_id}" title="How this was worked out">${escapeHtml(o.name)}</button>${o.gates_away ? ` <span class="chip" title="Gates to walk through from where it is now">${walkText(o.gates_away)}</span>` : ""}
      <div class="muted tiny">${nf(o.area_ha)} ha · reading ${o.reading ? escapeHtml(o.reading) : "—"}</div></td>
    <td class="num">${nf(o.now)}</td>
    <td class="num"><b>${feedDays(o)}</b>${o.days.low < o.days.median ? ` <span class="muted tiny">(dry ${o.days.low >= FEED_HORIZON ? `${FEED_HORIZON}+` : o.days.low})</span>` : ""}</td>
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
              ${m.leaving?.stays ? `Stays until it leaves on <b>${day(m.leaving.date)}</b>${m.leaving.note ? ` (${escapeHtml(m.leaving.note)})` : ""}, then off from ${escapeHtml(m.leaving.yards || "the yards")}.`
                : `${m.move_in <= 0 ? '<b class="bad">Move now</b>' : `Move by <b>${day(m.move_by)}</b> (${m.move_in} days)`}:
              ${m.why === "feed" ? `feed down to ${nf(r.residual)} kg/ha` : `the ${r.max_days}-day limit`}.${m.leaving?.last ? ` Leaves on <b>${day(m.leaving.date)}</b>${m.leaving.note ? ` (${escapeHtml(m.leaving.note)})` : ""}: the next paddock only needs ${m.leaving.need} days of feed and should be close to ${escapeHtml(m.leaving.yards || "the yards")}.` : ""}`}
              ${m.notes.length ? `<span class="muted">${m.notes.map(escapeHtml).join("; ")}.</span>` : ""}</p>
            ${m.options.length ? `
            <table class="list"><thead><tr><th>Next paddock</th><th class="num">kg/ha now</th><th class="num">Days of feed</th><th class="num">Rested, days</th></tr></thead><tbody>
              ${m.suggested ? optRow(m.suggested, true, mi) : ""}
              ${m.options.filter((o) => !m.suggested || o.paddock_id !== m.suggested.paddock_id).slice(0, 4).map((o) => optRow(o, false, mi)).join("")}
            </tbody></table>
            ${!m.suggested ? '<p class="small bad">Every paddock with a week of feed is already taken by a more urgent mob.</p>' : ""}`
            : m.leaving?.stays ? "" : `<p class="small bad">No empty paddock has ${m.leaving ? m.leaving.need : r.min_days} days of feed for this mob above ${nf(r.residual)} kg/ha.</p>`}
          </section>`).join("")}
        ${p.unplanned?.length ? `<p class="small muted">Not planned (in a management-only or holding area, not a paddock): ${p.unplanned.map((u) => `${escapeHtml(u.mob)} (${u.head} hd, ${escapeHtml(u.where)})`).join("; ")}.</p>` : ""}
        <p class="muted tiny">Days of feed: until the paddock is grazed down to the residual by this mob, with growth from today's soil water across past seasons — the median, and a drier run in brackets. Worked out up to ${FEED_HORIZON} days ("+" means more than that). Bold is the suggestion: the most urgent mob gets its best paddock first. Rested: days since the paddock was last grazed; on poorer country (FORAGE's carrying capacity) a rest counts for less, as shown under it. Only empty paddocks with pasture readings are offered.</p>
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
