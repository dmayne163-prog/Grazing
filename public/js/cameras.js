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
          <div class="camimg"><a href="/api/camera-shots/${shots[0].id}.jpg" target="_blank" rel="noopener" data-full><img alt="${escapeHtml(c.name)}, ${escapeHtml(shots[0].taken_on)}" src="/api/camera-shots/${shots[0].id}.jpg" loading="lazy"></a>${c.roi ? roiSvg(c.roi) : ""}</div>
          ${shots.length > 1 ? `<input type="range" min="0" max="${shots.length - 1}" value="${shots.length - 1}" data-slide aria-label="Day">` : ""}
          <div class="camnav">
            ${shots.length > 1 ? '<button class="btn" data-prev title="The day before">◀</button>' : ""}
            <span class="when small" data-when>${whenText(shots[0])}</span>
            ${shots.length > 1 ? '<button class="btn" data-next title="The day after" disabled>▶</button>' : ""}
          </div>
          ${greenHtml(c, shots, ctx)}`
          : `<p class="muted small">No pictures yet: one is taken each morning${data.on ? "" : " once the NVR is set up on the server"}.</p>`}
        ${ctx.canEdit && data.on ? `<div class="btns"><button class="btn" data-cam-shot="${c.id}">Take a picture now</button>${c.preset == null ? `<button class="btn" data-cam-hist="${c.id}">Fill in past days…</button>` : ""}</div>` : ""}
        ${c.history ? `<p class="small" data-hist-note="${c.id}">${histText(c.history)}</p>` : ""}
      </div>`;
    }).join("")}
    ${!data.on && ctx.canEdit ? '<p class="muted tiny">The server has no camera NVR set up (NVR_HOST, NVR_USER and NVR_PASS in its local.env).</p>' : ""}
    ${ctx.canEdit && data.on ? `<div class="btns"><button class="btn" id="camAdd">Add a camera…</button></div>` : ""}
    <p class="muted tiny">One picture a day from each camera, mid-morning, so the days compare fairly. Click a picture to open it full size.
      Greenness is the share of the light that's green in the grass box (outlined): it rises as the grass greens up and falls as it dries off or is eaten down.
      Compare it only with the same camera's other days; a picture taken at night, in fog or glare isn't scored.</p>`;

  el.querySelectorAll("[data-cam-hist]").forEach((b) => {
    b.onclick = () => historyDialog(ctx, data.cameras.find((x) => x.id === Number(b.dataset.camHist)), reload);
  });
  // A fill-in under way: show its progress, and redraw when it's done.
  for (const c of data.cameras) if (c.history && !c.history.finished) watchHistory(el, c.id, reload);
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
      when.textContent = whenText(s);
      slide.value = String(shots.length - 1 - i);
      prev.disabled = i >= shots.length - 1;
      next.disabled = i <= 0;
      showGreen(wrap, shots, i);
    };
    let i = 0;
    slide.oninput = () => { i = shots.length - 1 - Number(slide.value); show(i); };
    prev.onclick = () => { i = Math.min(shots.length - 1, i + 1); show(i); };
    next.onclick = () => { i = Math.max(0, i - 1); show(i); };
    // Clicking a day on the chart shows that day's picture.
    wrap.querySelectorAll(".greenchart .gp").forEach((pt) => {
      pt.addEventListener("click", () => { const k = shots.findIndex((x) => x.taken_on === pt.dataset.day); if (k >= 0) { i = k; show(i); } });
    });
    showGreen(wrap, shots, 0);
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
const timeOf = (ms) => new Date(ms).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const whenText = (s) => `${day(s.taken_on)}${s.from_recording ? `, from a recording at ${timeOf(s.taken_at)}` : ""}`;

/** A stored area: four corners, or a box from before corners. */
const cornersOf = (roi) => (roi.length === 4 && typeof roi[0] === "number" ? [[roi[0], roi[1]], [roi[2], roi[1]], [roi[2], roi[3]], [roi[0], roi[3]]] : roi);

/** The grass area outlined over a picture: an SVG stretched over it. */
function roiSvg(roi) {
  const pts = cornersOf(roi).map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(" ");
  return `<svg class="roisvg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="${pts}" class="roiline"/></svg>`;
}

/** The greenness line under a camera's pictures: the day's figure, the change on a week before, and a chart. */
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
  const t = Date.parse(`${s.taken_on}T00:00:00`);
  const gap = (x) => (t - Date.parse(`${x.taken_on}T00:00:00`)) / 86_400_000;
  // A week earlier, or the nearest scored day 5 to 10 days before.
  const before = scored(shots).filter((x) => gap(x) >= 5 && gap(x) <= 10).sort((a, b) => Math.abs(gap(a) - 7) - Math.abs(gap(b) - 7))[0];
  const diff = before ? s.gcc - before.gcc : null;
  return `Greenness <b>${g100(s.gcc)}</b>${diff === null ? "" : ` <span class="${diff > 0.002 ? "good" : diff < -0.002 ? "warnc" : "muted"}">(${diff >= 0 ? "+" : "−"}${g100(Math.abs(diff))} on ${new Date(`${before.taken_on}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" })})</span>`}`;
}

const CW = 300, CH = 80, PAD = 4, LEFT = 24;
/** Greenness by day, oldest at the left, with month marks; the day shown is ringed. Click a day to see it. */
function chartSvg(ok) {
  const pts = [...ok].reverse(); // oldest first
  const ms = (p) => Date.parse(`${p.taken_on}T00:00:00`);
  const t0 = ms(pts[0]), t1 = ms(pts[pts.length - 1]);
  const lo = Math.min(...pts.map((p) => p.gcc)), hi = Math.max(...pts.map((p) => p.gcc));
  const span = Math.max(hi - lo, 0.01);
  const xt = (t) => LEFT + ((t - t0) / Math.max(1, t1 - t0)) * (CW - LEFT - PAD);
  const x = (p) => xt(ms(p));
  const y = (p) => CH - 12 - ((p.gcc - (lo - span * 0.1)) / (span * 1.2)) * (CH - 12 - PAD);
  // A gap of more than 3 days breaks the line.
  const line = pts.map((p, i) => `${i && ms(p) - ms(pts[i - 1]) <= 3 * 86_400_000 ? "L" : "M"}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const months = [];
  for (let d = new Date(t0); d.getTime() <= t1; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const m1 = new Date(d.getFullYear(), d.getMonth() + (d.getDate() === 1 ? 0 : 1), 1).getTime();
    if (m1 >= t0 && m1 <= t1) months.push(m1);
  }
  const r = pts.length > 60 ? 1.6 : 2.2;
  return `<svg class="greenchart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Greenness by day, ${pts.length} days">
    ${[...new Set(months)].map((m) => `<line x1="${xt(m).toFixed(1)}" x2="${xt(m).toFixed(1)}" y1="${PAD}" y2="${CH - 12}" class="gm"/><text x="${xt(m).toFixed(1)}" y="${CH - 2}" class="gt" text-anchor="middle">${new Date(m).toLocaleDateString("en-AU", { month: "short" })}</text>`).join("")}
    <path d="${line}" class="gl"/>
    ${pts.map((p) => `<circle cx="${x(p).toFixed(1)}" cy="${y(p).toFixed(1)}" r="${r}" class="gp${p.from_recording ? " rec" : ""}" data-day="${p.taken_on}"><title>${p.taken_on}: ${g100(p.gcc)}${p.from_recording ? " (from a recording)" : ""}</title></circle>`).join("")}
    <text x="0" y="9" class="gt">${g100(hi)}</text>
    <text x="0" y="${CH - 13}" class="gt">${g100(lo)}</text>
  </svg>`;
}

function showGreen(wrap, shots, i) {
  const t = wrap.querySelector("[data-green-text]");
  if (t) t.innerHTML = greenText(shots, i);
  wrap.querySelectorAll(".greenchart .gp").forEach((c) => c.classList.toggle("on", c.dataset.day === shots[i]?.taken_on));
}

/** Click four corners of open grass on the newest picture; drag a corner to adjust. */
function grassDialog(ctx, cam, shot, after) {
  const d = ctx.dialog;
  d.innerHTML = `
    <div class="dlg wide">
      <header><h2>Grass area for ${escapeHtml(cam.name)}</h2></header>
      <div class="body">
        <p class="small"><b>Click four corners</b> around open grass. The greenness is read from inside them each day. Drag a corner to move it.</p>
        <ul class="small">
          <li>Grass only: no sky, trees, bushes, fences, troughs or tracks. Use the corners to follow the edge of the grass.</li>
          <li>Stay away from the trough and gateways: they're grazed harder than the rest of the paddock.</li>
          <li>Middle distance is best: not the grass right in front of the camera, not the far horizon.</li>
        </ul>
        <div class="roipick"><img src="/api/camera-shots/${shot.id}.jpg" alt="${escapeHtml(cam.name)}" draggable="false">
          <svg class="roisvg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon class="roiline" points=""/><polyline class="roiline" points=""/></svg></div>
        <p class="muted tiny" id="roiHint"></p>
      </div>
      <footer class="btns">
        ${cam.roi ? '<button class="btn danger" id="roiClear">Remove the area</button>' : ""}
        <button class="btn" id="roiRestart">Start again</button>
        <button class="btn" id="roiCancel">Cancel</button><button class="btn primary" id="roiSave" disabled>Save</button>
      </footer>
    </div>`;
  const $ = (s) => d.querySelector(s);
  const pick = $(".roipick"), poly = $(".roisvg polygon"), open = $(".roisvg polyline");
  let pts = cam.roi ? cornersOf(cam.roi).map((p) => [...p]) : [];
  const handles = [];
  const draw = () => {
    const str = pts.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(" ");
    poly.setAttribute("points", pts.length === 4 ? str : "");
    open.setAttribute("points", pts.length < 4 ? str : "");
    // A round handle on each corner, placed in the picture's pixels so it stays round.
    while (handles.length > pts.length) handles.pop().remove();
    while (handles.length < pts.length) { const h = document.createElement("div"); h.className = "roihandle"; pick.append(h); handles.push(h); }
    pts.forEach(([x, y], k) => { handles[k].style.left = `${x * 100}%`; handles[k].style.top = `${y * 100}%`; handles[k].dataset.k = String(k); });
    $("#roiSave").disabled = pts.length !== 4;
    $("#roiHint").textContent = pts.length < 4 ? `Corner ${pts.length + 1} of 4: click on the picture.` : "Drag a corner to adjust it, then Save.";
  };
  const frac = (e) => {
    const r = pick.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  let dragging = -1;
  pick.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const p = frac(e);
    // Near a corner: drag it. Otherwise, while placing, add a corner.
    const r = pick.getBoundingClientRect();
    const near = pts.findIndex(([x, y]) => Math.hypot((x - p[0]) * r.width, (y - p[1]) * r.height) < 18);
    if (near >= 0) { dragging = near; pick.setPointerCapture(e.pointerId); return; }
    if (pts.length < 4) { pts.push(p); draw(); }
  });
  pick.addEventListener("pointermove", (e) => { if (dragging >= 0) { pts[dragging] = frac(e); draw(); } });
  pick.addEventListener("pointerup", () => { dragging = -1; });
  $("#roiRestart").onclick = () => { pts = []; draw(); };
  $("#roiCancel").onclick = () => d.close();
  const save = async (value) => {
    try {
      await send("PATCH", `/api/cameras/${cam.id}`, { roi: value });
      d.close();
      ctx.toast(value ? "Grass area saved: every picture is being scored again" : "Grass area removed");
      setTimeout(() => after?.(), value ? 3000 : 0);
    } catch (e) { ctx.toast(e.message, { error: true }); }
  };
  $("#roiSave").onclick = () => save(pts.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]));
  $("#roiClear")?.addEventListener("click", () => save(null));
  d.showModal();
  draw();
}

/* ------------------------- past days from recordings ------------------------ */

function histText(h) {
  if (!h.finished) return `Filling in past days from the NVR's recordings: <b>${h.done} of ${h.total}</b> days checked${h.day ? ` (now ${day(h.day)})` : ""}, ${h.added} added. It carries on if you leave this page.`;
  return h.error ? `<span class="bad">Filling in stopped: ${escapeHtml(h.error)}</span> (${h.added} days added; start it again to carry on)`
    : `<span class="muted">Filled in ${h.added} past day${h.added === 1 ? "" : "s"} from the NVR's recordings (${day(h.from)} to ${day(h.to)}).</span>`;
}

const watching = new Set();
function watchHistory(el, id, reload) {
  if (watching.has(id)) return;
  watching.add(id);
  let lastAdded = -1;
  const tick = async () => {
    let r;
    try { r = (await get(`/api/cameras/${id}/history`)).run; } catch { r = null; }
    const note = el.querySelector(`[data-hist-note="${id}"]`);
    if (!r || !note?.isConnected) { watching.delete(id); return; }
    note.innerHTML = histText(r);
    // Redraw now and then so the pictures and chart grow as it goes.
    if (r.finished || (r.added - lastAdded >= 20 && lastAdded >= 0)) { watching.delete(id); reload(); return; }
    if (lastAdded < 0) lastAdded = r.added;
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 3000);
}

async function historyDialog(ctx, cam, after) {
  const d = ctx.dialog;
  d.innerHTML = '<div class="dlg narrow"><div class="body"><p class="muted">Asking the NVR how far back its recordings go…</p></div></div>';
  d.showModal();
  let info;
  try { info = await get(`/api/cameras/${cam.id}/recordings`); }
  catch (e) { d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div><div class="btns"><button class="btn" id="hClose">Close</button></div>`; d.querySelector("#hClose").onclick = () => d.close(); return; }
  if (!info.oldest) { d.querySelector(".body").innerHTML = '<p>The NVR has no recordings for this camera.</p><div class="btns"><button class="btn" id="hClose">Close</button></div>'; d.querySelector("#hClose").onclick = () => d.close(); return; }
  const days = Math.round((Date.now() - Date.parse(`${info.oldest}T00:00:00`)) / 86_400_000);
  d.innerHTML = `
    <div class="dlg narrow">
      <header><h2>Fill in past days for ${escapeHtml(cam.name)}</h2></header>
      <div class="body">
        <p>The NVR has recordings from this camera back to <b>${day(info.oldest)}</b> (about ${days} days).</p>
        <p class="small">For each day without a picture, the app takes up to three pictures from that morning's recordings (around 9:30, 10:30 and 11:30) and keeps the one with the middle greenness, so cattle walking past in one of them don't throw the day out. Days with no recording that morning are skipped.</p>
        <p class="small">It runs in the background: about a minute for every 5–10 days, so the whole lot can take an hour or two. Newest days are filled first.</p>
        <p class="small muted">If this camera was moved or knocked at some point, pictures from before then won't line up with the grass area: slide back through them to check.</p>
        <div class="f"><label for="hFrom">From</label><input id="hFrom" type="date" min="${info.oldest}" value="${info.oldest}"></div>
      </div>
      <footer class="btns"><button class="btn" id="hCancel">Cancel</button><button class="btn primary" id="hGo">Start</button></footer>
    </div>`;
  d.querySelector("#hCancel").onclick = () => d.close();
  d.querySelector("#hGo").onclick = async () => {
    try {
      await send("POST", `/api/cameras/${cam.id}/history`, { from: d.querySelector("#hFrom").value });
      d.close();
      ctx.toast(`Filling in ${cam.name}'s past days in the background`);
      after?.();
    } catch (e) { ctx.toast(e.message, { error: true }); }
  };
}
