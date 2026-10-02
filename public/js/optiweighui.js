/**
 * Tools → Optiweigh: the link's status, and each Optiweigh session with the
 * mob it's assigned to. A session's weights only come in once it's assigned:
 * to a mob (its animals and weights follow that mob), or as a record only
 * (weights on each animal, nothing else).
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const when = (ts) => new Date(ts).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export async function loadOptiweigh(ctx, el) {
  if (!el) return;
  let o;
  try {
    o = await get("/api/optiweigh");
  } catch (e) {
    el.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!el.isConnected) return;
  if (!o.configured) {
    el.innerHTML = '<p class="muted small">Not linked: this server has no Optiweigh API key. Weights can still be imported from the portal\'s CSV above.</p>';
    return;
  }
  const mobs = [...ctx.state.mobs].sort((a, b) => a.name.localeCompare(b.name));
  const last = o.last;
  const waiting = o.sessions.filter((s) => s.mob_id === null && !s.record_only);
  el.innerHTML = `
    <p class="small">${o.running ? "Fetching from Optiweigh now…"
      : last ? (last.error ? `<span class="bad">Last fetch ${when(last.at)} failed: ${escapeHtml(last.error)}</span>`
        : `Last fetched ${when(last.at)}: ${last.weighed.toLocaleString("en-AU")} new weights${last.created ? `, ${last.created} new animals` : ""}. Fetched each morning.`)
      : "Not fetched yet."}</p>
    ${waiting.length ? `<div class="note warn small">${waiting.length === 1 ? "A session is" : `${waiting.length} sessions are`} waiting to be assigned. Its weights are held until you choose which mob it's with.</div>` : ""}
    <table class="list">
      <thead><tr><th>Session</th><th>Dates</th><th>Weights go to</th></tr></thead>
      <tbody>${o.sessions.map((s) => `
        <tr>
          <td>${escapeHtml(s.name || `#${s.session_id}`)}<div class="muted tiny">${s.synced_to ? `in to ${day(s.synced_to)}` : "not fetched yet"}</div></td>
          <td class="muted small nowrap">${day(s.start_date)} – ${s.end_date ? day(s.end_date) : "now"}</td>
          <td>${ctx.canEdit ? `<select data-ow="${s.session_id}">
              <option value=""${s.mob_id === null && !s.record_only ? " selected" : ""}>Not assigned: hold</option>
              <option value="record"${s.record_only ? " selected" : ""}>Record only: on each animal, no mob</option>
              <optgroup label="A mob">
                ${mobs.map((m) => `<option value="${m.id}"${m.id === s.mob_id ? " selected" : ""}>${escapeHtml(m.name)} · ${m.head} hd</option>`).join("")}
                ${s.mob_id !== null && !mobs.some((m) => m.id === s.mob_id) ? `<option value="${s.mob_id}" selected>${escapeHtml(s.mob_name)} (no longer on hand)</option>` : ""}
              </optgroup>
            </select>`
            : escapeHtml(s.record_only ? "Record only" : s.mob_name || "Not assigned")}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <p class="muted tiny">Sessions that ended before the link was switched on are records only: their weights are on each animal, found by searching for it, but not tied to any mob. Assigning a session to a mob brings in its weights, adds animals the app hasn't met to that mob (an animal already in another mob is never moved), and keeps the mob's weekly weight and gain up to date.</p>
    ${ctx.canEdit ? '<div class="btns"><button class="btn" id="owSync">Fetch now</button></div>' : ""}`;

  el.querySelectorAll("[data-ow]").forEach((sel) => {
    sel.onchange = async () => {
      const v = sel.value;
      const body = v === "record" ? { mob_id: null, record_only: true } : v === "" ? { mob_id: null, record_only: false } : { mob_id: Number(v), record_only: false };
      try {
        await send("PUT", `/api/optiweigh/sessions/${sel.dataset.ow}`, body);
        ctx.toast("Saved. Fetching its weights from Optiweigh; a long session takes a minute or two.");
        setTimeout(() => loadOptiweigh(ctx, el), 1500);
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
  });
  const sync = el.querySelector("#owSync");
  if (sync) sync.onclick = async () => {
    try {
      await send("POST", "/api/optiweigh/sync", {});
      ctx.toast("Fetching from Optiweigh");
      setTimeout(() => loadOptiweigh(ctx, el), 1500);
    } catch (e) {
      ctx.toast(e.message, { error: true });
    }
  };
  if (o.running) setTimeout(() => loadOptiweigh(ctx, el), 5000);
}
