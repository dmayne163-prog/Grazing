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
          <div class="camimg"><a href="/api/camera-shots/${shots[0].id}.jpg" target="_blank" rel="noopener" data-full><img alt="${escapeHtml(c.name)}, ${escapeHtml(shots[0].taken_on)}" src="/api/camera-shots/${shots[0].id}.jpg" loading="lazy"></a>${c.roi ? '<div class="roibox" data-roi></div>' : ""}</div>
          ${shots.length > 1 ? `<input type="range" min="0" max="${shots.length - 1}" value="${shots.length - 1}" data-slide aria-label="Day">` : ""}
          <div class="camnav">
            ${shots.length > 1 ? '<button class="btn" data-prev title="The day before">◀</button>' : ""}
            <span class="when small" data-when>${day(shots[0].taken_on)}</span>
            ${shots.length > 1 ? '<button class="btn" data-next title="The day after" disabled>▶</button>' : ""}
          </div>
          ${greenHtml(c, shots, ctx)}`
          : `<p class="muted small">No pictures yet: one is taken each morning${data.on ? "" : " once the NVR is set up on the server"}.</p>`}
        ${ctx.canEdit && data.on ? `<div class="btns"><button class="btn" data-cam-shot="${c.id}">Take a picture now</button></div>` : ""}
      </div>`;
    }).join("")}
    ${!data.on && ctx.canEdit ? '<p class="muted tiny">The server has no camera NVR set up (NVR_HOST, NVR_USER and NVR_PASS in its local.env).</p>' : ""}
    ${ctx.canEdit && data.on ? `<div class="btns"><button class="btn" id="camAdd">Add a camera…</button></div>` : ""}
    <p class="muted tiny">One picture a day from each camera, mid-morning, so the days compare fairly. Click a picture to open it full size.
      Greenness is the share of the light that's green in the grass box (outlined): it rises as the grass greens up and falls as it dries off or is eaten down.
      Compare it only with the same camera's other days; a picture taken at night, in fog or glare isn't scored.</p>`;

  // The grass box over each picture.
  el.querySelectorAll(".camshot[data-cam]").forEach((wrap) => {
    const c = data.cameras.find((x) => x.id === Number(wrap.dataset.cam));
    const box = wrap.querySelector("[data-roi]");
    if (c?.roi && box) placeBox(box, c.roi);
  });
  el.querySelectorAll("[data-cam-roi]").forEach((b) => {
    b.onclick = () => {
      const c = data.cameras.find((x) => x.id === Number(b.dataset.camRoi));
      const latest = data.shots.find((s) => s.camera_id === c.id);
      if (latest) grassDialog(ctx, c, latest, reload);
    };
  });

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
      showGreen(wrap, shots, i);
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

/* ------------------------------- greenness -------------------------------- */

const g100 = (v) => (v * 100).toFixed(1);
const scored = (shots) => shots.filter((s) => s.gcc != null && s.gcc_ok);

/** The greenness line under a camera's pictures: today's figure, the change on a week ago, and a chart. */
function greenHtml(c, shots, ctx) {
  if (!c.roi) {
    return `<p class="muted small">${ctx.canEdit ? `To get a greenness score, <button class="linkbtn" data-cam-roi="${c.id}">mark the grass area…</button>` : "No grass area marked for a greenness score yet."}</p>`;
  }
  const ok = scored(shots);
  return `<div class="greenline">
    <div class="small" data-green-text>${greenText(shots, 0)}</div>
    ${ok.length >= 2 ? chartSvg(ok) : ""}
    ${ctx.canEdit ? `<button class="linkbtn tiny" data-cam-roi="${c.id}">Move the grass area…</button>` : ""}
  </div>`;
}

function greenText(shots, i) {
  const s = shots[i];
  if (!s) return "";
  if (s.gcc == null) return '<span class="muted">Greenness: being worked out…</span>';
  if (!s.gcc_ok) return `<span class="muted">Not scored: ${s.gcc_why || "the picture can't be trusted"}.</span>`;
  // A week earlier, or the nearest scored day 5 to 10 days before.
  const t = Date.parse(`${s.taken_on}T00:00:00`);
  const before = scored(shots).filter((x) => { const d = (t - Date.parse(`${x.taken_on}T00:00:00`)) / 86_400_000; return d >= 5 && d <= 10; })
    .sort((a, b) => Math.abs((t - Date.parse(`${a.taken_on}T00:00:00`)) / 86_400_000 - 7) - Math.abs((t - Date.parse(`${b.taken_on}T00:00:00`)) / 86_400_000 - 7))[0];
  const diff = before ? s.gcc - before.gcc : null;
  return `Greenness <b>${g100(s.gcc)}</b>${diff === null ? "" : ` <span class="${diff > 0.002 ? "good" : diff < -0.002 ? "warnc" : "muted"}">(${diff >= 0 ? "+" : "−"}${g100(Math.abs(diff))} on ${new Date(`${before.taken_on}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" })})</span>`}`;
}

const CW = 300, CH = 70, PAD = 4;
/** Greenness by day, oldest at the left; the day shown is ringed. */
function chartSvg(ok) {
  const pts = [...ok].reverse(); // oldest first
  const t0 = Date.parse(`${pts[0].taken_on}T00:00:00`), t1 = Date.parse(`${pts[pts.length - 1].taken_on}T00:00:00`);
  const lo = Math.min(...pts.map((p) => p.gcc)), hi = Math.max(...pts.map((p) => p.gcc));
  const span = Math.max(hi - lo, 0.01);
  const x = (p) => PAD + 22 + ((Date.parse(`${p.taken_on}T00:00:00`) - t0) / Math.max(1, t1 - t0)) * (CW - 2 * PAD - 22);
  const y = (p) => CH - PAD - ((p.gcc - (lo - span * 0.1)) / (span * 1.2)) * (CH - 2 * PAD);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  return `<svg class="greenchart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Greenness by day, ${pts.length} days">
    <path d="${line}" class="gl"/>
    ${pts.map((p) => `<circle cx="${x(p).toFixed(1)}" cy="${y(p).toFixed(1)}" r="2" class="gp" data-day="${p.taken_on}"><title>${p.taken_on}: ${g100(p.gcc)}</title></circle>`).join("")}
    <text x="0" y="9" class="gt">${g100(hi)}</text>
    <text x="0" y="${CH - 1}" class="gt">${g100(lo)}</text>
  </svg>`;
}

function showGreen(wrap, shots, i) {
  const t = wrap.querySelector("[data-green-text]");
  if (t) t.innerHTML = greenText(shots, i);
  wrap.querySelectorAll(".greenchart .gp").forEach((c) => c.classList.toggle("on", c.dataset.day === shots[i]?.taken_on));
}

/** Positions a box element over its picture from [left, top, right, bottom] fractions. */
function placeBox(box, roi) {
  const [l, t, r, b] = roi;
  box.style.left = `${l * 100}%`; box.style.top = `${t * 100}%`;
  box.style.width = `${(r - l) * 100}%`; box.style.height = `${(b - t) * 100}%`;
}

/** Drag a box over open grass on the newest picture. */
function grassDialog(ctx, cam, shot, after) {
  const d = ctx.dialog;
  d.innerHTML = `
    <div class="dlg wide">
      <header><h2>Grass area for ${escapeHtml(cam.name)}</h2></header>
      <div class="body">
        <p class="small">Drag a box over <b>open grass</b>: the greenness is read from inside it each day.</p>
        <ul class="small">
          <li>Keep it on grass only: no sky, trees, fences, troughs or tracks.</li>
          <li>Stay away from the trough and gateways: they're grazed harder than the rest of the paddock.</li>
          <li>Middle distance is best: not the grass right in front of the camera, not the far horizon.</li>
        </ul>
        <div class="roipick"><img src="/api/camera-shots/${shot.id}.jpg" alt="${escapeHtml(cam.name)}" draggable="false"><div class="roibox" hidden></div></div>
        <p class="muted tiny" id="roiHint">${cam.roi ? "The outline is the current area. Drag to draw a new one." : "Press and drag on the picture."}</p>
      </div>
      <footer class="btns">
        ${cam.roi ? '<button class="btn danger" id="roiClear">Remove the area</button>' : ""}
        <button class="btn" id="roiCancel">Cancel</button><button class="btn primary" id="roiSave" disabled>Save</button>
      </footer>
    </div>`;
  const $ = (s) => d.querySelector(s);
  const pick = $(".roipick"), box = $(".roibox");
  let roi = cam.roi ? [...cam.roi] : null;
  const draw = () => { if (roi) { box.hidden = false; placeBox(box, roi); } else box.hidden = true; };
  draw();
  let start = null;
  const frac = (e) => {
    const r = pick.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  pick.addEventListener("pointerdown", (e) => { e.preventDefault(); pick.setPointerCapture(e.pointerId); start = frac(e); roi = [...start, ...start]; draw(); });
  pick.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = frac(e);
    roi = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.max(start[0], p[0]), Math.max(start[1], p[1])];
    draw();
  });
  pick.addEventListener("pointerup", () => {
    start = null;
    const big = roi && roi[2] - roi[0] >= 0.03 && roi[3] - roi[1] >= 0.03;
    $("#roiSave").disabled = !big;
    $("#roiHint").textContent = big ? "Happy with it? Save. Or drag again to redraw." : "Too small: drag a bigger box.";
  });
  $("#roiCancel").onclick = () => d.close();
  const save = async (value) => {
    try {
      await send("PATCH", `/api/cameras/${cam.id}`, { roi: value });
      d.close();
      ctx.toast(value ? "Grass area saved: every picture is being scored again" : "Grass area removed");
      setTimeout(() => after?.(), value ? 2500 : 0);
    } catch (e) { ctx.toast(e.message, { error: true }); }
  };
  $("#roiSave").onclick = () => save(roi.map((v) => Math.round(v * 10000) / 10000));
  $("#roiClear")?.addEventListener("click", () => save(null));
  d.showModal();
}
