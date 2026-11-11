/**
 * Notes from the paddock, with a photo: on a paddock, water point or any other
 * map feature, or on a mob. Made on the phone, in signal or out of it — out
 * of signal the note (photo and all) waits in the outbox and shows here as
 * "waiting to send" until it goes.
 *
 * Photos are shrunk on the phone before they're kept or sent (longest side
 * 1600 px, JPEG): a few hundred KB instead of several MB, which matters on
 * one bar of signal.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";
import { list as outboxList } from "./outbox.js";

const MAX_SIDE = 1600;
const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const pad = (n) => String(n).padStart(2, "0");
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function notesSectionHtml(canEdit) {
  return `<h3>Notes and photos</h3>
    ${canEdit ? '<div class="btns"><button class="btn" id="noteAdd">Add a note or photo…</button></div>' : ""}
    <div id="fieldNotes"><p class="muted small">Loading…</p></div>`;
}

/** The notes on one thing, newest first, with any still waiting on the phone. */
export async function loadNotes(ctx, target, id, root, name) {
  const el = root.querySelector("#fieldNotes");
  if (!el) return;
  const add = root.querySelector("#noteAdd");
  if (add) add.onclick = () => openNoteDialog(ctx, target, id, name, () => loadNotes(ctx, target, id, root, name));

  let notes = null;
  let offline = false;
  try {
    notes = await get(`/api/notes?target=${target}&id=${id}`);
  } catch {
    // Out of signal and never opened here: every note is in the offline copy.
    try { notes = (await get("/api/notes")).filter((n) => n.target === target && n.target_id === id); offline = true; } catch { notes = []; offline = true; }
  }
  const waiting = (await outboxList()).filter((i) => i.path === "/api/notes" && i.body?.target === target && i.body?.target_id === id);
  if (!el.isConnected) return;
  if (!notes.length && !waiting.length) {
    el.innerHTML = `<p class="muted small">${offline ? "No notes in the offline copy." : "No notes yet."}</p>`;
    return;
  }
  el.innerHTML = `<ul class="notes">
    ${waiting.map((w) => noteHtml({ date: w.body.date, time: w.body.time, text: w.body.text, photo: w.body.photo, username: null }, w.status === "failed" ? `Not sent: ${w.error}` : "Waiting to send")).join("")}
    ${notes.map((n) => noteHtml(n, null, ctx.canEdit)).join("")}
  </ul>`;
  el.querySelectorAll("[data-del-note]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this note?")) return;
      try {
        await send("DELETE", `/api/notes/${b.dataset.delNote}`);
        loadNotes(ctx, target, id, root, name);
      } catch (e) {
        ctx.toast(e.message, { error: true });
      }
    };
  });
}

function noteHtml(n, pending, canDelete = false) {
  return `<li class="note-item${pending ? " pending" : ""}">
    <div class="muted tiny">${escapeHtml(day(n.date))}${n.time ? ` ${escapeHtml(n.time)}` : ""}${n.username ? ` · ${escapeHtml(n.username)}` : ""}${pending ? ` · <b>${escapeHtml(pending)}</b>` : ""}
      ${canDelete && n.id ? `<button class="linkbtn" data-del-note="${n.id}">Delete</button>` : ""}</div>
    ${n.text ? `<p>${escapeHtml(n.text)}</p>` : ""}
    ${n.photo ? `<a href="${escapeHtml(n.photo)}" target="_blank" rel="noopener"><img class="note-photo" src="${escapeHtml(n.photo)}" alt="Photo" loading="lazy"></a>` : ""}
  </li>`;
}

export function openNoteDialog(ctx, target, id, name, after) {
  const d = ctx.dialog;
  d.innerHTML = `
    <div class="dlg narrow">
      <header><h2>Note on ${escapeHtml(name || "this")}</h2></header>
      <div class="body">
        <div class="f"><label for="nText">Note</label><textarea id="nText" rows="4" placeholder="e.g. Trough leaking at the float, wash-out on the track"></textarea></div>
        <div class="f"><label for="nPhoto">Photo</label><input id="nPhoto" type="file" accept="image/*" capture="environment"></div>
        <div id="nPreview"></div>
        <div class="f"><label for="nDate">Date</label><input id="nDate" type="date" value="${todayIso()}" max="${todayIso()}"></div>
      </div>
      <footer><button class="btn" id="nCancel">Cancel</button><button class="btn primary" id="nGo">Save note</button></footer>
    </div>`;
  let photo = null;
  d.querySelector("#nCancel").onclick = () => d.close();
  d.querySelector("#nPhoto").onchange = async (e) => {
    const file = e.target.files?.[0];
    const box = d.querySelector("#nPreview");
    photo = null;
    if (!file) { box.innerHTML = ""; return; }
    box.innerHTML = '<p class="muted small">Getting the photo ready…</p>';
    try {
      photo = await shrink(file);
      box.innerHTML = `<img class="note-photo" src="${photo}" alt="The photo"><p class="muted tiny">${Math.round((photo.length * 0.75) / 1024)} KB</p>`;
    } catch {
      box.innerHTML = '<p class="bad small">That photo couldn\'t be read. Try taking it again.</p>';
    }
  };
  d.querySelector("#nGo").onclick = async () => {
    const btn = d.querySelector("#nGo");
    const text = d.querySelector("#nText").value.trim();
    const date = d.querySelector("#nDate").value;
    if (!text && !photo) { ctx.toast("Write something or add a photo", { error: true }); return; }
    btn.disabled = true;
    try {
      const body = { target, target_id: id, text, photo, ...(date && date !== todayIso() ? { date, time: null } : {}) };
      const r = await send("POST", "/api/notes", body, { queue: `Note on ${name || target}${photo ? " (with photo)" : ""}` });
      d.close();
      ctx.toast(r.queued ? "Note saved on the phone — it sends when you're back in signal" : "Note saved", r.queued ? { ms: 6000 } : undefined);
      after?.();
    } catch (e) {
      btn.disabled = false;
      ctx.toast(e.message, { error: true });
    }
  };
  d.showModal();
}

/** The photo as a JPEG data URL, longest side at most 1600 px, the right way up. */
async function shrink(file) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Older browsers: through an <img> from a data URL (blob: URLs are outside the CSP).
    const url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }
  const w = src.width, h = src.height;
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}
