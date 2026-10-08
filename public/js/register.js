/**
 * The head count register: every change to a mob's head count, newest first,
 * with the head before and after, the property total after, and the notes
 * taken at the time — for explaining actual against expected numbers at
 * audit time. Struck-out and undone records are listed but not counted.
 * A note can be added to any line later; notes are never changed.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const stamp = (ms) => new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function openRegister(ctx) {
  const d = ctx.dialog;
  const now = new Date();
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const f = { from: iso(yearAgo), to: iso(now), mob: "", property: true };
  let r = null;
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Loading…</p></div></div>';
  if (!d.open) d.showModal();

  const load = async () => {
    const q = new URLSearchParams({ from: f.from, to: f.to, mob: f.mob, property: f.property ? "1" : "0" });
    try {
      r = await get(`/api/register?${q}`);
      draw();
    } catch (e) {
      d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    }
  };

  const notesHtml = (x) => [
    ...x.notes.map((n) => escapeHtml(n)),
    ...x.later_notes.map((n) => `${escapeHtml(n.text)} <span class="muted">(added ${escapeHtml(stamp(n.at))}${n.by ? `, ${escapeHtml(n.by)}` : ""})</span>`),
  ].join("<br>");

  const draw = () => {
    const t = r.totals;
    d.innerHTML = `
      <div class="dlg wide report">
        <header>
          <h2>Head count register</h2>
          <div class="row2 no-print">
            <div class="f"><label for="rgFrom">From</label><input type="date" id="rgFrom" value="${f.from}"></div>
            <div class="f"><label for="rgTo">To</label><input type="date" id="rgTo" value="${f.to}"></div>
          </div>
          <div class="row2 no-print">
            <div class="f"><label for="rgMob">Mob</label><select id="rgMob"><option value="">All mobs</option>
              ${r.mob_names.map((n) => `<option${n === f.mob ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select></div>
            <div class="f"><label class="radio"><input type="checkbox" id="rgProp"${f.property ? " checked" : ""}> Only changes to the property's total</label>
              <span class="muted tiny">Untick to include drafts and merges between mobs.</span></div>
          </div>
        </header>
        <div class="body">
          <p class="small">${day(f.from)} to ${day(f.to)}${f.mob ? ` · ${escapeHtml(f.mob)}` : ""}:
            purchases <b>${signed(t.purchases)}</b>, sales <b>${signed(t.sales)}</b>, deaths <b>${signed(t.deaths)}</b>, recounts <b>${signed(t.recounts)}</b>
            ${f.property ? `· net <b>${signed(t.net)}</b>` : ""}. On hand now: <b>${r.property_now}</b> head, agisted included.</p>
          <table class="list register"><thead><tr><th>Date</th><th>Mob</th><th>What</th><th class="num">Change</th><th class="num">Mob</th><th class="num">Property</th><th>Notes</th><th>Recorded</th></tr></thead><tbody>
            ${r.rows.map((x, i) => `<tr class="${x.status === "counted" ? "" : "voided"}">
              <td>${day(x.date)}${x.time ? ` <span class="muted tiny">${escapeHtml(x.time)}</span>` : ""}</td>
              <td>${escapeHtml(x.mob)}${x.owner ? `<div class="muted tiny">owner ${escapeHtml(x.owner)}</div>` : ""}</td>
              <td>${escapeHtml(x.what)}${x.other_mob ? ` <span class="muted">${escapeHtml(x.other_mob)}</span>` : ""}
                ${x.status !== "counted" ? `<div class="bad tiny">${escapeHtml(x.status)}${x.status_note ? `: ${escapeHtml(x.status_note)}` : ""} · not counted</div>` : ""}</td>
              <td class="num">${signed(x.change)}</td>
              <td class="num">${x.before} → ${x.after}</td>
              <td class="num">${x.status === "counted" && x.property ? x.property_after : ""}</td>
              <td class="small">${notesHtml(x) || '<span class="muted">—</span>'}
                ${ctx.canEdit && x.id ? `<div class="no-print"><button class="linkbtn" data-note="${i}">Add a note</button></div>` : ""}</td>
              <td class="tiny">${escapeHtml(x.recorded_by || "")}<div class="muted">${escapeHtml(x.source)}${x.source === "this app" ? ` · ${escapeHtml(stamp(x.recorded_at))}` : ""}</div></td>
            </tr>`).join("") || '<tr><td colspan="8" class="muted">No changes in that time.</td></tr>'}
          </tbody></table>
          <p class="muted tiny">Mob is the mob's head before → after. Property is the whole property's head after the change, agisted cattle included. A recount's change is the difference it found. Struck-out records (marked as mistakes) and undone records are shown but don't count; undone records are kept from 9 October 2026, when this register began.</p>
        </div>
        <footer class="btns"><button class="btn" id="rgClose">Close</button><button class="btn" id="rgPrint">Print</button><button class="btn primary" id="rgCsv">Export CSV</button></footer>
      </div>`;

    const reload = () => {
      f.from = d.querySelector("#rgFrom").value || f.from;
      f.to = d.querySelector("#rgTo").value || f.to;
      f.mob = d.querySelector("#rgMob").value;
      f.property = d.querySelector("#rgProp").checked;
      load();
    };
    ["#rgFrom", "#rgTo", "#rgMob", "#rgProp"].forEach((s) => { d.querySelector(s).onchange = reload; });
    d.querySelector("#rgClose").onclick = () => d.close();
    d.querySelector("#rgPrint").onclick = () => {
      document.body.classList.add("printing-report");
      window.print();
      setTimeout(() => document.body.classList.remove("printing-report"), 500);
    };
    d.querySelector("#rgCsv").onclick = () => {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [["Date", "Time", "Mob", "Owner", "What", "Other mob", "Change", "Mob before", "Mob after", "Property after", "Status", "Notes", "Recorded by", "Source", "Recorded at"].map(q).join(",")];
      for (const x of r.rows) {
        const notes = [...x.notes, ...x.later_notes.map((n) => `${n.text} (added ${stamp(n.at)}${n.by ? `, ${n.by}` : ""})`)].join(" | ");
        lines.push([x.date, x.time, x.mob, x.owner, x.what, x.other_mob, x.change, x.before, x.after,
          x.status === "counted" && x.property ? x.property_after : "", x.status + (x.status_note ? `: ${x.status_note}` : ""),
          notes, x.recorded_by, x.source, stamp(x.recorded_at)].map(q).join(","));
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
      a.download = `Head count register ${f.from} to ${f.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    d.querySelectorAll("[data-note]").forEach((b) => {
      b.onclick = async () => {
        const x = r.rows[Number(b.dataset.note)];
        const text = prompt(`A note on ${x.what.toLowerCase()} of ${Math.abs(x.change)} hd, ${x.mob}, ${day(x.date)}.\nNotes are kept with your name and the time and can't be changed afterwards.`);
        if (!text || !text.trim()) return;
        try {
          await send("POST", `/api/mob-events/${x.id}/notes`, { text });
          ctx.toast("Note added");
          load();
        } catch (e) {
          ctx.toast(e.message, { error: true });
        }
      };
    });
  };
  load();
}
