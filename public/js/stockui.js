/**
 * Stock actions in the interface: the move / draft pop-up, the mob page, and
 * the gate panel. Everything here talks to the server's action routes, and
 * everything it records can be undone — from the toast straight after, or
 * from the history later.
 *
 * `ctx` is supplied by main.js: { state, toast, refresh, select, selectMob, canEdit, dialog }.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const $ = (sel, root) => root.querySelector(sel);
const nf0 = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const kg = (v) => (v == null ? "—" : `${nf0.format(v)} kg`);
const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—");
const plural = (n, one, many) => (n === 1 ? one : many);

export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const paddocksOf = (ctx) =>
  ctx.state.features.filter((f) => f.properties.kind === "paddock")
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name, "en", { numeric: true }));
const paddockName = (ctx, id) => ctx.state.byId.get(id)?.properties.name ?? `#${id}`;

/* ------------------------------ "when" fields ------------------------------ */

/** Now, or an earlier date and time from the calendar. */
export function whenHtml(prefix) {
  return `
    <div class="f">
      <label>When</label>
      <div class="radios">
        <label class="radio"><input type="radio" name="${prefix}When" value="now" checked> Now</label>
        <label class="radio"><input type="radio" name="${prefix}When" value="earlier"> Earlier</label>
      </div>
      <div class="row2" id="${prefix}Earlier" hidden>
        <input type="date" id="${prefix}Date" max="${localToday()}" value="${localToday()}" aria-label="Date">
        <input type="time" id="${prefix}Time" aria-label="Time">
      </div>
    </div>`;
}

export function bindWhen(root, prefix, onChange) {
  const box = $(`#${prefix}Earlier`, root);
  root.querySelectorAll(`input[name="${prefix}When"]`).forEach((r) => {
    r.addEventListener("change", () => {
      box.hidden = !$(`input[name="${prefix}When"][value="earlier"]`, root).checked;
      onChange?.();
    });
  });
  $(`#${prefix}Date`, root).addEventListener("change", () => onChange?.());
  $(`#${prefix}Time`, root).addEventListener("change", () => onChange?.());
}

/** {} for now (the server stamps it), or { date, time } for earlier. */
export function readWhen(root, prefix) {
  const earlier = $(`input[name="${prefix}When"][value="earlier"]`, root).checked;
  if (!earlier) return {};
  const date = $(`#${prefix}Date`, root).value;
  if (!date) throw new Error("Choose the date");
  return { date, time: $(`#${prefix}Time`, root).value || null };
}

/* -------------------------------- undo toast ------------------------------- */

export function undoable(ctx, message, batch) {
  ctx.toast(message, batch ? {
    action: {
      label: "Undo",
      run: async () => {
        try {
          await send("POST", `/api/undo/${batch}`);
          await ctx.refresh();
          ctx.toast("Undone");
        } catch (e) {
          ctx.toast(e.message, { error: true });
        }
      },
    },
  } : {});
}

/* ------------------------------- move dialog ------------------------------- */

/**
 * The pop-up for moving a mob: after a drag onto a paddock (dest given), or
 * from the mob page (dest chosen here). Whole mob, or only some — which
 * drafts those off as a new mob in the destination.
 */
export function openMoveDialog(ctx, m, dest) {
  const dialog = ctx.dialog;
  const where = m.paddocks.map((p) => p.name).join(" + ");
  const home = m.paddock_ids[0];
  const others = ctx.state.mobs.filter((x) => x.id !== m.id && x.paddock_ids[0] === home);
  const choices = paddocksOf(ctx).filter((f) => f.id !== home);

  dialog.innerHTML = `
    <div class="dlg narrow">
      <header>
        <h2>Move ${escapeHtml(m.name)}</h2>
        <div class="muted small">${m.head} hd · now in ${escapeHtml(where)}${m.owner ? ` · ${escapeHtml(m.owner)}'s` : ""}</div>
      </header>
      <div class="body">
        <div class="f"><label for="mvTo">To</label>
          ${dest
            ? `<div class="dest">${escapeHtml(dest.properties.name)}</div>`
            : `<select id="mvTo"><option value="">Choose a paddock…</option>${choices.map((f) => `<option value="${f.id}">${escapeHtml(f.properties.name)}</option>`).join("")}</select>`}
        </div>
        <div class="f"><label>How many</label>
          <div class="radios">
            <label class="radio"><input type="radio" name="mvHow" value="all" checked> The whole mob (${m.head} hd)</label>
            <label class="radio"><input type="radio" name="mvHow" value="some"> Only some of them</label>
          </div>
        </div>
        <div id="mvSome" hidden>
          <div class="row2">
            <div class="f"><label for="mvHead">Head moved</label><input id="mvHead" type="number" min="1" max="${m.head - 1}" inputmode="numeric"></div>
            <div class="f"><label for="mvKg">Average weight (kg)</label><input id="mvKg" type="number" min="1" step="1" inputmode="numeric" placeholder="${m.est_weight_kg ? `${Math.round(m.est_weight_kg)} if left blank` : "optional"}"></div>
          </div>
          <div class="f"><label for="mvName">Name for the ones moved</label><input id="mvName" value="${escapeHtml(`${m.name} (draft)`)}" autocomplete="off"></div>
          ${m.sex ? "" : `<div class="f"><label for="mvSex">Sex of the ones moved</label>
            <select id="mvSex"><option value="">mixed / unknown</option><option value="female">female</option><option value="steer">steer</option><option value="male">male</option></select></div>`}
          <div class="f"><label for="mvWhich">Which ones</label><input id="mvWhich" placeholder="e.g. the 20 lightest, tags 101–120" autocomplete="off"></div>
          <p class="muted small">They become a separate mob in the new paddock. ${escapeHtml(m.name)} keeps the rest where they are.</p>
        </div>
        ${others.length ? `<div class="f" id="mvOthers"><label>Also move</label>
          ${others.map((o) => `<label class="radio"><input type="checkbox" value="${o.id}"> ${escapeHtml(o.name)} <span class="muted">${o.head} hd</span></label>`).join("")}
        </div>` : ""}
        ${whenHtml("mv")}
        <div class="f" id="mvNoteRow"><label for="mvNote">Note</label><input id="mvNote" placeholder="optional" autocomplete="off"></div>
      </div>
      <footer>
        <button class="btn" id="mvCancel">Cancel</button>
        <button class="btn primary" id="mvGo">Move</button>
      </footer>
    </div>`;

  const some = () => $('input[name="mvHow"][value="some"]', dialog).checked;
  const refreshForm = () => {
    $("#mvSome", dialog).hidden = !some();
    const oth = $("#mvOthers", dialog);
    if (oth) oth.hidden = some();
    $("#mvNoteRow", dialog).hidden = some();
    const n = some() ? Number($("#mvHead", dialog).value) || 0 : m.head;
    const extra = some() ? 0 : [...dialog.querySelectorAll("#mvOthers input:checked")].length;
    $("#mvGo", dialog).textContent = some()
      ? (n ? `Move ${n} hd` : "Move")
      : extra ? `Move ${extra + 1} mobs` : `Move ${m.head} hd`;
  };
  dialog.querySelectorAll('input[name="mvHow"], #mvOthers input').forEach((el) => el.addEventListener("change", refreshForm));
  $("#mvHead", dialog).addEventListener("input", refreshForm);
  bindWhen(dialog, "mv");
  $("#mvCancel", dialog).onclick = () => dialog.close();

  $("#mvGo", dialog).onclick = async () => {
    const btn = $("#mvGo", dialog);
    try {
      const to = dest ? dest.id : Number($("#mvTo", dialog).value);
      if (!to) throw new Error("Choose where they went");
      const when = readWhen(dialog, "mv");
      const toName = paddockName(ctx, to);
      btn.disabled = true;
      if (some()) {
        const head = Number($("#mvHead", dialog).value);
        if (!Number.isInteger(head) || head < 1 || head >= m.head) {
          throw new Error(`Enter how many moved: 1 to ${m.head - 1}. For all ${m.head}, choose the whole mob.`);
        }
        const r = await send("POST", `/api/mobs/${m.id}/draft`, {
          head, to: [to], ...when,
          name: $("#mvName", dialog).value,
          sex: $("#mvSex", dialog)?.value || undefined,
          weight_kg: $("#mvKg", dialog).value || null,
          note: $("#mvWhich", dialog).value,
        });
        dialog.close();
        await ctx.refresh();
        undoable(ctx, `${head} hd drafted off to ${toName}`, r.batch);
      } else {
        const ids = [m.id, ...[...dialog.querySelectorAll("#mvOthers input:checked")].map((c) => Number(c.value))];
        const r = await send("POST", "/api/actions/move", { mob_ids: ids, to: [to], ...when, note: $("#mvNote", dialog).value });
        dialog.close();
        await ctx.refresh();
        undoable(ctx, ids.length > 1 ? `${ids.length} mobs moved to ${toName}` : `${m.name} moved to ${toName}`, r.batch);
      }
    } catch (e) {
      btn.disabled = false;
      showError(dialog, e.message);
    }
  };
  refreshForm();
  dialog.showModal();
}

export function showError(root, message) {
  const body = $(".body", root);
  $(".note.err", body)?.remove();
  body.insertAdjacentHTML("afterbegin", `<div class="note err">${escapeHtml(message)}</div>`);
  body.scrollTop = 0;
}

/* ------------------------------- weigh dialog ------------------------------ */

/**
 * A mob's average weight, from Optiweigh, the yard scales or an estimate.
 * The gain since the last weighing is worked out as you type and can be kept
 * as the assumed daily gain, which projects the weight forward until the next
 * weighing — that projected weight is what AE is worked from.
 */
export function openWeighDialog(ctx, m) {
  const dialog = ctx.dialog;
  dialog.innerHTML = `
    <div class="dlg narrow">
      <header>
        <h2>Record weight</h2>
        <div class="muted small">${escapeHtml(m.name)} · ${m.head} hd${m.last_weighed ? ` · last ${kg(m.weight_kg)} on ${day(m.last_weighed)}` : ""}</div>
      </header>
      <div class="body">
        <div class="row2">
          <div class="f"><label for="wKg">Average weight (kg)</label><input id="wKg" type="number" min="1" step="0.1" inputmode="decimal" autocomplete="off"></div>
          <div class="f"><label for="wHead">Head weighed</label><input id="wHead" type="number" min="1" max="${m.head}" inputmode="numeric" placeholder="all ${m.head}"></div>
        </div>
        <div class="f"><label>How</label>
          <div class="radios">
            <label class="radio"><input type="radio" name="wHow" value="optiweigh" checked> Optiweigh</label>
            <label class="radio"><input type="radio" name="wHow" value="scales"> Yard scales</label>
            <label class="radio"><input type="radio" name="wHow" value="estimate"> Estimate</label>
          </div>
        </div>
        ${whenHtml("w")}
        <div class="f"><label for="wAdg">Assumed daily gain (kg/day)</label>
          <input id="wAdg" type="number" step="0.01" min="-3" max="3" inputmode="decimal" placeholder="none: weight stays as weighed">
          <div class="hint" id="wGain"></div>
        </div>
        <div class="f"><label for="wNote">Note</label><input id="wNote" placeholder="optional" autocomplete="off"></div>
      </div>
      <footer>
        <button class="btn" id="wCancel">Cancel</button>
        <button class="btn primary" id="wGo">Save weight</button>
      </footer>
    </div>`;

  // Gain since the last weighing, from the weight and date being entered.
  const gainHint = () => {
    const box = $("#wGain", dialog);
    const kgNow = Number($("#wKg", dialog).value);
    box.innerHTML = "";
    if (!kgNow || !m.last_weighed || !m.weight_kg) return;
    let date = localToday();
    try { date = readWhen(dialog, "w").date ?? date; } catch { /* keep today */ }
    const days = Math.round((Date.parse(`${date}T00:00:00`) - Date.parse(`${m.last_weighed}T00:00:00`)) / 86_400_000);
    if (days < 7) return;
    const gain = Math.round(((kgNow - m.weight_kg) / days) * 100) / 100;
    box.innerHTML = `Since ${day(m.last_weighed)} (${days} days): <b>${gain > 0 ? "+" : ""}${gain} kg/day</b> <button class="linkbtn" id="wUse">Use this</button><br><span class="muted">Only a real gain if the mob hasn't had cattle drafted off or merged in since.</span>`;
    $("#wUse", box).onclick = () => { $("#wAdg", dialog).value = String(gain); };
  };
  $("#wKg", dialog).addEventListener("input", gainHint);
  bindWhen(dialog, "w", gainHint);
  $("#wCancel", dialog).onclick = () => dialog.close();

  $("#wGo", dialog).onclick = async () => {
    const btn = $("#wGo", dialog);
    try {
      const weight = Number($("#wKg", dialog).value);
      if (!weight) throw new Error("Enter the average weight in kg");
      btn.disabled = true;
      const r = await send("POST", `/api/mobs/${m.id}/weigh`, {
        weight_kg: weight,
        head_weighed: $("#wHead", dialog).value || null,
        method: $('input[name="wHow"]:checked', dialog).value,
        adg_kg: $("#wAdg", dialog).value === "" ? null : Number($("#wAdg", dialog).value),
        note: $("#wNote", dialog).value,
        ...readWhen(dialog, "w"),
      });
      dialog.close();
      await ctx.refresh();
      undoable(ctx, `${m.name}: ${nf0.format(weight)} kg recorded`, r.batch);
    } catch (e) {
      btn.disabled = false;
      showError(dialog, e.message);
    }
  };
  dialog.showModal();
  $("#wKg", dialog).focus();
}

/* ------------------------------ head dialogs ------------------------------- */

/** Deaths or a recount: a number, a when, a note. */
function headDialog(ctx, m, { title, field, value, go, path, hint, done }) {
  const d = ctx.dialog;
  d.innerHTML = `
    <div class="dlg narrow">
      <header><h2>${escapeHtml(title)}</h2><div class="muted small">${escapeHtml(m.name)} · ${m.head} hd now</div></header>
      <div class="body">
        <div class="f"><label for="hN">${escapeHtml(field)}</label><input id="hN" type="number" min="0" inputmode="numeric" value="${escapeHtml(value)}"></div>
        ${hint ? `<p class="muted small">${escapeHtml(hint)}</p>` : ""}
        ${whenHtml("h")}
        <div class="f"><label for="hNote">Note</label><input id="hNote" placeholder="optional" autocomplete="off"></div>
      </div>
      <footer><button class="btn" id="hCancel">Cancel</button><button class="btn primary" id="hGo">${escapeHtml(go)}</button></footer>
    </div>`;
  bindWhen(d, "h");
  $("#hCancel", d).onclick = () => d.close();
  $("#hGo", d).onclick = async () => {
    const btn = $("#hGo", d);
    try {
      const n = $("#hN", d).value;
      if (n === "") throw new Error(`Enter ${field.toLowerCase()}`);
      btn.disabled = true;
      const r = await send("POST", `/api/mobs/${m.id}/${path}`, { head: Number(n), note: $("#hNote", d).value, ...readWhen(d, "h") });
      d.close();
      await ctx.refresh();
      undoable(ctx, done(n), r.batch);
    } catch (e) {
      btn.disabled = false;
      showError(d, e.message);
    }
  };
  d.showModal();
  $("#hN", d).select();
}

/* --------------------------------- mob page -------------------------------- */

export function mobPageHtml(ctx, m) {
  const where = m.paddocks.map((p) => `<button class="linkbtn" data-paddock="${p.id}">${escapeHtml(p.name)}</button>`).join(" + ");
  const facts = [
    ["Breed", escapeHtml(m.breed || "—")],
    ["Class", escapeHtml([m.age_class, m.sex].filter(Boolean).join(" · ") || "—")],
    ["Born", day(m.birth_date)],
    ["Origin", escapeHtml(m.origin || "—")],
    ["Tag colour", escapeHtml(m.tag_colour || "—")],
    ["Last weighed", m.last_weighed ? `${kg(m.weight_kg)} on ${day(m.last_weighed)}` : "—"],
    ["Daily gain", m.adg_kg ? `${m.adg_kg} kg/day (assumed)` : "none set"],
    ["AE per head", m.ae_head != null ? m.ae_head.toFixed(2) : "—"],
  ];
  if (m.agriwebb_ae_head != null) facts.push(["AgriWebb AE/head", m.agriwebb_ae_head.toFixed(2)]);
  const owners = [...new Set(ctx.state.mobs.map((x) => x.owner).filter(Boolean))];

  return `
    <button class="linkbtn back" id="back">← All mobs</button>
    <h2>${escapeHtml(m.name)}</h2>
    <p class="sub">${escapeHtml(m.species)}${m.owner ? ` · <span class="chip owner">${escapeHtml(m.owner)}</span> agistment` : ""}</p>

    <div class="statuscard">
      <div class="big"><b>${m.head} hd</b> · ${where || "not in a paddock"}</div>
      <div class="muted small">${m.in_paddock_since ? `since ${day(m.in_paddock_since)} · ` : ""}${kg(m.est_weight_kg)} · ${m.ae_total != null ? `${nf0.format(m.ae_total)} AE` : "AE unknown"}</div>
      ${ctx.canEdit ? `<div class="btns">
        <button class="btn primary" id="mMove">Move…</button>
        <button class="btn" id="mDraft">Draft some off…</button>
        <button class="btn" id="mWeigh">Record weight…</button>
        <button class="btn" id="mDeaths">Deaths…</button>
        <button class="btn" id="mRecount">Recount…</button>
      </div>
      <p class="muted tiny">Or drag the mob's icon on the map. To give it more paddocks, open a gate: click the gate on the map.</p>` : ""}
    </div>

    <h3>Animals</h3>
    <div id="mobAnimals"><p class="muted small">Loading…</p></div>

    <h3>History</h3>
    <ul class="history" id="mobEvents"><li class="muted">Loading…</li></ul>

    <details class="gap-top">
      <summary class="small">Details</summary>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${ctx.canEdit ? `
        <div class="f"><label for="mName">Name</label><input id="mName" value="${escapeHtml(m.name)}" autocomplete="off"></div>
        <div class="row2">
          <div class="f"><label for="mOwner">Owner</label>
            <input id="mOwner" value="${escapeHtml(m.owner || "")}" placeholder="own stock" list="mOwners" autocomplete="off">
            <datalist id="mOwners">${owners.map((o) => `<option value="${escapeHtml(o)}">`).join("")}</datalist>
          </div>
          <div class="f"><label for="mSex">Sex</label>
            <select id="mSex">${["", "female", "steer", "male"].map((v) => `<option value="${v}"${v === (m.sex || "") ? " selected" : ""}>${v || "mixed / unknown"}</option>`).join("")}</select>
          </div>
        </div>
        <div class="f"><label for="mDesc">Description</label><textarea id="mDesc">${escapeHtml(m.description || "")}</textarea></div>
        <div class="btns"><button class="btn" id="mSave">Save details</button></div>`
      : m.description ? `<p>${escapeHtml(m.description)}</p>` : ""}
    </details>`;
}

export function bindMobPage(ctx, m, root) {
  $("#back", root).onclick = ctx.backToMobs;
  root.querySelectorAll("[data-paddock]").forEach((el) => {
    el.onclick = () => ctx.select(Number(el.dataset.paddock), { zoom: true });
  });
  const mv = $("#mMove", root);
  if (mv) mv.onclick = () => openMoveDialog(ctx, m, null);
  const dr = $("#mDraft", root);
  if (dr) dr.onclick = () => {
    openMoveDialog(ctx, m, null);
    const r = $('input[name="mvHow"][value="some"]', ctx.dialog);
    r.checked = true;
    r.dispatchEvent(new Event("change"));
  };
  const wg = $("#mWeigh", root);
  if (wg) wg.onclick = () => openWeighDialog(ctx, m);
  $("#mDeaths", root)?.addEventListener("click", () => headDialog(ctx, m, {
    title: "Record deaths", field: "How many died", value: "1", go: "Record", path: "deaths",
    done: (n) => `${n} death${Number(n) === 1 ? "" : "s"} recorded in ${m.name}`,
  }));
  $("#mRecount", root)?.addEventListener("click", () => headDialog(ctx, m, {
    title: "Recount", field: "Head counted", value: String(m.head), go: "Save count", path: "recount",
    hint: "The mob's head from this moment on. For a death or sale, record that instead, so the history says why the number changed.",
    done: (n) => `${m.name} counted at ${n} hd`,
  }));
  const save = $("#mSave", root);
  if (save) save.onclick = async () => {
    try {
      await send("PATCH", `/api/mobs/${m.id}`, {
        name: $("#mName", root).value, owner: $("#mOwner", root).value,
        sex: $("#mSex", root).value, description: $("#mDesc", root).value,
      });
      await ctx.refresh();
      ctx.toast("Saved");
    } catch (e) {
      ctx.toast(e.message, { error: true });
    }
  };
  loadMobEvents(ctx, m.id, root);
}

const EVENT_TEXT = {
  opening: (e) => e.agriwebb_event === "Created from draft/split" ? `Drafted off${e.from_mob ? ` from ${e.from_mob}` : ""} · ${e.head} hd`
    : e.agriwebb_event === "Purchased" ? `Purchased · ${e.head} hd`
    : e.from_mob ? `Drafted off from ${e.from_mob} · ${e.head} hd`
    : e.source.startsWith("import:") ? `AgriWebb mob list (said ${e.head} hd)`
    : `Started · ${e.head} hd`,
  move: (e) => e.reason === "gate opened" ? `${e.gate_name || "Gate"} opened`
    : e.reason === "gate closed" ? `${e.gate_name || "Gate"} closed` : "Moved",
  transfer: (e) => e.off_farm ? `Transferred off farm · ${Math.abs(e.head_change)} hd`
    : e.head_change < 0 ? `Drafted ${-e.head_change} hd${e.to_mob ? ` to ${e.to_mob}` : ""}${e.to_paddock ? ` (${e.to_paddock})` : ""}`
    : `Merged in ${e.head_change} hd${e.from_mob ? ` from ${e.from_mob}` : ""}`,
  sale: (e) => `Sold ${-e.head_change} hd`,
  death: (e) => `${-e.head_change} died`,
  purchase: (e) => `Bought ${e.head_change} hd`,
  count: (e) => `Recounted: ${e.head} hd`,
  weigh: (e) => {
    if (!e.weight_kg) return "Weighed (weight not recorded)";
    const how = { optiweigh: "Optiweigh", scales: "yard scales", estimate: "estimate" }[e.method];
    const extra = [how, e.head_weighed ? `${e.head_weighed} hd weighed` : null, e.adg_kg ? `${e.adg_kg > 0 ? "+" : ""}${e.adg_kg} kg/day assumed` : null].filter(Boolean);
    return `Weighed · ${nf0.format(e.weight_kg)} kg${extra.length ? ` (${extra.join(", ")})` : ""}`;
  },
};

async function loadMobEvents(ctx, id, root) {
  const el = $("#mobEvents", root);
  try {
    const all = await get(`/api/mobs/${id}/events`);
    if (!el.isConnected) return;
    const weighed = new Set(all.filter((e) => e.kind === "weigh" && e.weight_kg).map((e) => e.date));
    const events = all.filter((e) => !(e.kind === "weigh" && !e.weight_kg && weighed.has(e.date)));
    const shown = new Set();
    el.innerHTML = events.map((e) => {
      // One undo per action, on its first line: a draft is two records.
      const undo = ctx.canEdit && e.source === "app" && !(e.batch && shown.has(e.batch));
      if (e.batch) shown.add(e.batch);
      // Imported records (AgriWebb) can't be undone, but a wrong one can be
      // marked as a mistake — and that marking undone in turn.
      const canVoid = ctx.canEdit && e.source !== "app" && e.kind !== "opening" && !e.voided;
      return `
      <li class="${e.voided ? "voided" : ""}"><span class="when">${day(e.date)}${e.time ? `<br><span class="muted tiny">${escapeHtml(e.time)}</span>` : ""}</span>
      <span class="grow"><span class="what">${escapeHtml((EVENT_TEXT[e.kind] || (() => e.kind))(e))}${e.paddocks ? ` → ${escapeHtml(e.paddocks.join(" + "))}` : ""}</span>${e.note ? `<br><span class="muted tiny">${escapeHtml(e.note)}</span>` : ""}
        ${e.voided ? `<br><span class="tiny bad">Marked as a mistake${e.voided.reason ? `: ${escapeHtml(e.voided.reason)}` : ""}</span>` : ""}</span>
      ${undo ? `<button class="linkbtn danger-link" data-undo="${e.batch || ""}" data-event="${e.id}">Undo</button>` : ""}
      ${e.voided && ctx.canEdit ? `<button class="linkbtn" data-restore="${e.voided.batch}">Restore</button>` : ""}
      ${canVoid ? `<button class="linkbtn muted-link" data-void="${e.id}">Mistake?</button>` : ""}</li>`;
    }).join("") || '<li class="muted">Nothing recorded.</li>';
    el.querySelectorAll("[data-void]").forEach((b) => {
      b.onclick = async () => {
        const reason = prompt("Mark this record as a mistake? It stays in the history, struck out, and stops counting.\n\nWhy (optional):", "");
        if (reason === null) return;
        try {
          const r = await send("POST", `/api/mob-events/${b.dataset.void}/void`, { reason });
          await ctx.refresh();
          undoable(ctx, "Marked as a mistake", r.batch);
        } catch (e) {
          ctx.toast(e.message, { error: true });
        }
      };
    });
    el.querySelectorAll("[data-restore]").forEach((b) => {
      b.onclick = async () => {
        try {
          await send("POST", `/api/undo/${b.dataset.restore}`);
          await ctx.refresh();
          ctx.toast("Restored");
        } catch (e) {
          ctx.toast(e.message, { error: true });
        }
      };
    });
    el.querySelectorAll("[data-undo]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Undo this? Anything it recorded — including a mob it drafted off — is removed.")) return;
        try {
          if (b.dataset.undo) await send("POST", `/api/undo/${b.dataset.undo}`);
          else await send("DELETE", `/api/mob-events/${b.dataset.event}`);
          await ctx.refresh();
          ctx.toast("Undone");
        } catch (e) {
          ctx.toast(e.message, { error: true });
        }
      };
    });
  } catch {
    if (el) el.innerHTML = '<li class="muted">History is not available offline.</li>';
  }
}

/* -------------------------------- gate panel ------------------------------- */

export function gatePanelHtml() {
  return `<div id="gatePanel" class="statuscard"><p class="muted small">Loading gate…</p></div>`;
}

/**
 * Open or closed, which paddocks it joins, and the button to change it —
 * with a preview of which mobs that affects before anything is saved.
 */
export async function loadGatePanel(ctx, f, root) {
  const el = $("#gatePanel", root);
  let g;
  try {
    g = await get(`/api/gates/${f.id}`);
  } catch (e) {
    el.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!el.isConnected) return;
  const open = g.state === "open";
  const joined = g.paddocks.length === 2;
  const next = open ? "closed" : "open";
  const options = (sel) => paddocksOf(ctx).map((p) => `<option value="${p.id}"${p.id === sel ? " selected" : ""}>${escapeHtml(p.properties.name)}</option>`).join("");

  el.innerHTML = `
    <div class="big"><span class="gatestate ${open ? "open" : ""}">${open ? "Open" : "Closed"}</span>
      ${g.since ? `<span class="muted small"> since ${day(g.since.date)}${g.since.time ? ` ${escapeHtml(g.since.time)}` : ""}</span>` : `<span class="muted small"> (no record of it being opened)</span>`}</div>
    <p class="small">${joined
      ? `Joins <b>${escapeHtml(g.paddock_names[0])}</b> and <b>${escapeHtml(g.paddock_names[1])}</b>${g.manual ? "" : ' <span class="muted">(worked out from the map)</span>'}`
      : '<span class="bad">Can\'t tell which two paddocks this gate joins.</span>'}
      ${ctx.canEdit ? ` <button class="linkbtn" id="gChange">${joined ? "Change" : "Set them"}</button>` : ""}</p>
    <div id="gPick" ${joined ? "hidden" : ""}>
      <div class="row2">
        <select id="gA" aria-label="First paddock"><option value="">…</option>${options(g.paddocks[0])}</select>
        <select id="gB" aria-label="Second paddock"><option value="">…</option>${options(g.paddocks[1])}</select>
      </div>
      <div class="btns"><button class="btn" id="gPickSave">Save</button>${g.manual ? '<button class="linkbtn" id="gPickAuto">Work it out from the map</button>' : ""}</div>
    </div>
    ${ctx.canEdit && joined ? `
      <h3>${open ? "Close" : "Open"} the gate</h3>
      ${whenHtml("g")}
      <div id="gPreview" class="small"></div>
      <div class="f"><label for="gNote">Note</label><input id="gNote" placeholder="optional" autocomplete="off"></div>
      <div class="btns"><button class="btn primary" id="gGo">${open ? "Close gate" : "Open gate"}</button></div>` : ""}
    ${g.history.length ? `
      <h3>Gate history</h3>
      <ul class="history">${g.history.map((e, i) => `
        <li><span class="when">${day(e.date)}${e.time ? `<br><span class="muted tiny">${escapeHtml(e.time)}</span>` : ""}</span>
        <span class="grow">${e.state === "open" ? "Opened" : "Closed"}${e.note ? `<br><span class="muted tiny">${escapeHtml(e.note)}</span>` : ""}</span>
        ${ctx.canEdit && i === 0 ? `<button class="linkbtn danger-link" data-undo="${e.batch}">Undo</button>` : ""}</li>`).join("")}
      </ul>` : ""}`;

  const change = $("#gChange", el);
  if (change) change.onclick = () => { $("#gPick", el).hidden = false; };
  const savePick = async (paddocks) => {
    try {
      await send("PUT", `/api/gates/${f.id}/paddocks`, { paddocks });
      loadGatePanel(ctx, f, root);
      ctx.toast("Saved");
    } catch (e) {
      ctx.toast(e.message, { error: true });
    }
  };
  $("#gPickSave", el).onclick = () => savePick([Number($("#gA", el).value), Number($("#gB", el).value)]);
  const auto = $("#gPickAuto", el);
  if (auto) auto.onclick = () => savePick(null);

  el.querySelectorAll("[data-undo]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Undo this? The mobs it gave (or took) access go back to how they were.")) return;
      try {
        await send("POST", `/api/undo/${b.dataset.undo}`);
        await ctx.refresh();
        ctx.toast("Undone");
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
  });

  if (!ctx.canEdit || !joined) return;

  // The preview is rebuilt whenever the time changes: who is either side
  // depends on when.
  const sides = {};
  const preview = async () => {
    const box = $("#gPreview", el);
    let when;
    try { when = readWhen(el, "g"); } catch { box.textContent = ""; return; }
    try {
      const p = await send("POST", `/api/gates/${f.id}/preview`, { state: next, ...when });
      if (!p.changes.length) {
        box.innerHTML = `<p class="muted">No mobs either side are affected.</p>`;
        return;
      }
      box.innerHTML = next === "open"
        ? `<p>${p.changes.map((c) => `<b>${escapeHtml(c.mob_name)}</b> (${c.head} hd) will be able to reach ${escapeHtml(c.to_names.filter((n) => !c.from_names.includes(n)).join(", "))}`).join("<br>")}</p>`
        : `<p>Which side is each mob on?</p>${p.changes.map((c) => `
            <div class="f"><label>${escapeHtml(c.mob_name)} · ${c.head} hd</label>
              <select data-side="${c.mob_id}">${g.paddocks.map((pid, i) => `<option value="${pid}"${c.to.includes(pid) ? " selected" : ""}>${escapeHtml(g.paddock_names[i])}</option>`).join("")}</select>
            </div>`).join("")}`;
      box.querySelectorAll("[data-side]").forEach((s) => {
        sides[s.dataset.side] = Number(s.value);
        s.onchange = () => { sides[s.dataset.side] = Number(s.value); };
      });
    } catch (e) {
      box.innerHTML = `<p class="bad">${escapeHtml(e.message)}</p>`;
    }
  };
  bindWhen(el, "g", preview);
  preview();

  $("#gGo", el).onclick = async () => {
    const btn = $("#gGo", el);
    try {
      btn.disabled = true;
      const r = await send("POST", `/api/gates/${f.id}`, {
        state: next, ...readWhen(el, "g"), sides, note: $("#gNote", el).value,
      });
      await ctx.refresh();
      undoable(ctx, `${f.properties.name || "Gate"} ${next === "open" ? "opened" : "closed"}${r.changes.length ? ` · ${r.changes.length} ${plural(r.changes.length, "mob", "mobs")} affected` : ""}`, r.batch);
    } catch (e) {
      btn.disabled = false;
      ctx.toast(e.message, { error: true });
    }
  };
}
