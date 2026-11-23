/**
 * Paddock cameras: the daily picture from each security camera that looks
 * over this paddock, newest first, with a slider to go back through the days.
 * Cameras are added here by an administrator (the NVR channel and a name).
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

export function camerasSectionHtml() {
  return `<div id="camerasBox" hidden><h3>Camera pictures</h3><div id="cameras"></div></div>`;
}

export async function loadCameras(ctx, f, root) {
  const box = root.querySelector("#camerasBox");
  const el = root.querySelector("#cameras");
  if (!el) return;
  let data;
  try { data = await get(`/api/cameras?paddock=${f.id}`); } catch { return; }
  if (!el.isConnected) return;
  // Hidden on paddocks without a camera, unless an administrator could add one.
  if (!data.cameras.length && !(ctx.canEdit && data.on)) return;
  box.hidden = false;
  const name = f.properties.name || "this paddock";
  const reload = () => loadCameras(ctx, f, root);

  el.innerHTML = `
    ${data.cameras.map((c) => {
      const shots = data.shots.filter((s) => s.camera_id === c.id);
      return `<div class="camshot" data-cam="${c.id}">
        <div class="small"><b>${escapeHtml(c.name)}</b> <span class="muted">· channel ${c.channel}${c.preset != null ? `, turned to preset ${c.preset}` : ""}</span>
          ${ctx.canEdit ? ` <button class="linkbtn" data-cam-edit="${c.id}">Change</button>` : ""}</div>
        ${shots.length ? `
          <a href="/api/camera-shots/${shots[0].id}.jpg" target="_blank" rel="noopener" data-full><img alt="${escapeHtml(c.name)}, ${escapeHtml(shots[0].taken_on)}" src="/api/camera-shots/${shots[0].id}.jpg" loading="lazy"></a>
          ${shots.length > 1 ? `<input type="range" min="0" max="${shots.length - 1}" value="${shots.length - 1}" data-slide aria-label="Day">` : ""}
          <div class="camnav">
            ${shots.length > 1 ? '<button class="btn" data-prev title="The day before">◀</button>' : ""}
            <span class="when small" data-when>${day(shots[0].taken_on)}</span>
            ${shots.length > 1 ? '<button class="btn" data-next title="The day after" disabled>▶</button>' : ""}
          </div>`
          : `<p class="muted small">No pictures yet: one is taken each morning${data.on ? "" : " once the NVR is set up on the server"}.</p>`}
        ${ctx.canEdit && data.on ? `<div class="btns"><button class="btn" data-cam-shot="${c.id}">Take a picture now</button></div>` : ""}
      </div>`;
    }).join("")}
    ${!data.on && ctx.canEdit ? '<p class="muted tiny">The server has no camera NVR set up (NVR_HOST, NVR_USER and NVR_PASS in its local.env).</p>' : ""}
    ${ctx.canEdit && data.on ? `<div class="btns"><button class="btn" id="camAdd">Add a camera…</button></div>` : ""}
    <p class="muted tiny">One picture a day from each camera, mid-morning, so the days compare fairly. Click a picture to open it full size.</p>`;

  // Going back through the days: the slider runs oldest (left) to newest (right).
  el.querySelectorAll(".camshot[data-cam]").forEach((wrap) => {
    const cam = Number(wrap.dataset.cam);
    const shots = data.shots.filter((s) => s.camera_id === cam);
    if (shots.length < 2) return;
    const img = wrap.querySelector("img"), link = wrap.querySelector("[data-full]"), when = wrap.querySelector("[data-when]");
    const slide = wrap.querySelector("[data-slide]"), prev = wrap.querySelector("[data-prev]"), next = wrap.querySelector("[data-next]");
    const show = (i) => { // i: 0 = newest
      const s = shots[i];
      img.src = `/api/camera-shots/${s.id}.jpg`;
      img.alt = `${img.alt.split(",")[0]}, ${s.taken_on}`;
      link.href = img.src;
      when.textContent = day(s.taken_on);
      slide.value = String(shots.length - 1 - i);
      prev.disabled = i >= shots.length - 1;
      next.disabled = i <= 0;
    };
    let i = 0;
    slide.oninput = () => { i = shots.length - 1 - Number(slide.value); show(i); };
    prev.onclick = () => { i = Math.min(shots.length - 1, i + 1); show(i); };
    next.onclick = () => { i = Math.max(0, i - 1); show(i); };
  });

  el.querySelectorAll("[data-cam-shot]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = "Taking it… (up to a minute)";
      try { await send("POST", `/api/cameras/${b.dataset.camShot}/shot`); ctx.toast("Picture taken"); reload(); }
      catch (e) { ctx.toast(e.message, { error: true }); b.disabled = false; b.textContent = "Take a picture now"; }
    };
  });
  el.querySelector("#camAdd")?.addEventListener("click", () => cameraDialog(ctx, f.id, name, null, reload));
  el.querySelectorAll("[data-cam-edit]").forEach((b) => {
    b.onclick = () => cameraDialog(ctx, f.id, name, data.cameras.find((c) => c.id === Number(b.dataset.camEdit)), reload);
  });
}

function cameraDialog(ctx, featureId, padName, cam, after) {
  const d = ctx.dialog;
  d.innerHTML = `
    <div class="dlg narrow">
      <header><h2>${cam ? "Change the camera" : "Add a camera"} for ${escapeHtml(padName)}</h2></header>
      <div class="body">
        <div class="f"><label for="cmCh">Channel on the NVR</label><input id="cmCh" type="number" min="1" max="256" inputmode="numeric" value="${cam?.channel ?? ""}" placeholder="e.g. 4">
          <p class="muted tiny">The camera's number on the NVR's LIVE screen.</p></div>
        <div class="f"><label for="cmPreset">Preset (turning cameras only)</label><input id="cmPreset" type="number" min="1" max="255" inputmode="numeric" value="${cam?.preset ?? ""}" placeholder="blank for a fixed camera">
          <p class="muted tiny">For a camera that turns (PTZ): the number of the saved position that looks over this paddock. It's turned there for the picture, then back to its lowest-numbered preset, so make preset 1 the view it normally watches.</p></div>
        <div class="f"><label for="cmName">Name</label><input id="cmName" value="${escapeHtml(cam?.name || "")}" placeholder="e.g. ${escapeHtml(padName)} trough"></div>
      </div>
      <footer class="btns">
        ${cam ? '<button class="btn danger" id="cmDel">Remove</button>' : ""}
        <button class="btn" id="cmCancel">Cancel</button><button class="btn primary" id="cmGo">Save</button>
      </footer>
    </div>`;
  const $ = (s) => d.querySelector(s);
  $("#cmCancel").onclick = () => d.close();
  $("#cmDel")?.addEventListener("click", async () => {
    if (!confirm(`Stop taking pictures from ${cam.name}? The pictures already taken stay.`)) return;
    try { await send("DELETE", `/api/cameras/${cam.id}`); d.close(); ctx.toast("Camera removed"); after?.(); }
    catch (e) { ctx.toast(e.message, { error: true }); }
  });
  $("#cmGo").onclick = async () => {
    const body = { channel: $("#cmCh").value, preset: $("#cmPreset").value, name: $("#cmName").value };
    try {
      if (cam) await send("PATCH", `/api/cameras/${cam.id}`, body);
      else await send("POST", "/api/cameras", { feature_id: featureId, ...body });
      d.close();
      ctx.toast(cam ? "Camera saved" : "Camera added: take a picture now to check it");
      after?.();
    } catch (e) { ctx.toast(e.message, { error: true }); }
  };
  d.showModal();
}
