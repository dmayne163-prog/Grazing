/* global L */
/**
 * Tools → Tidy paddock boundaries: where neighbouring paddocks overlap, and
 * any boundary that crosses or doubles back on itself. The tidy-up gives each
 * small overlap to the smaller paddock; nothing changes until Apply, and the
 * last tidy-up can be undone.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const nf = (v, d = 2) => Number(v).toLocaleString("en-AU", { maximumFractionDigits: d });
const size = (h) => (h < 0.1 ? `${nf(h * 10_000, 0)} m²` : `${nf(h, 2)} ha`);
const when = (ts) => new Date(ts).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

let shown = null;

/** Draws overlaps (red) and problem corners (orange rings) on the map, and goes to them. */
function showOnMap(ctx, geoms, points) {
  clearMap();
  const map = ctx.map;
  shown = L.layerGroup().addTo(map);
  const shapes = L.geoJSON({ type: "FeatureCollection", features: geoms.map((g) => ({ type: "Feature", geometry: g, properties: {} })) }, {
    style: { color: "#E0453A", weight: 3, fillColor: "#E0453A", fillOpacity: 0.5 },
    interactive: false,
  }).addTo(shown);
  for (const [lon, lat] of points) {
    L.circleMarker([lat, lon], { radius: 12, color: "#F29D38", weight: 3, fill: false, interactive: false }).addTo(shown);
  }
  const b = shapes.getBounds();
  for (const [lon, lat] of points) b.extend([lat, lon]);
  if (b.isValid()) map.fitBounds(b.pad(geoms.length + points.length > 2 ? 0.1 : 3), { maxZoom: 19 });
}

function clearMap() {
  if (shown) { shown.remove(); shown = null; }
}

export async function openTidy(ctx) {
  clearMap();
  const d = ctx.dialog;
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Checking every paddock boundary…</p></div></div>';
  if (!d.open) d.showModal();
  let p;
  try {
    p = await get("/api/boundaries/check");
  } catch (e) {
    d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>
      <div class="btns"><button class="btn" id="tdClose">Close</button></div>`;
    d.querySelector("#tdClose").onclick = () => d.close();
    return;
  }
  if (!d.open) return;

  const toTidy = p.overlaps.filter((o) => o.action === "tidy");
  const toCheck = p.overlaps.filter((o) => o.action === "check");
  const back = { label: "Back to the list", run: () => openTidy(ctx) };
  const goTo = (geoms, points, msg) => {
    d.close();
    showOnMap(ctx, geoms, points);
    ctx.toast(msg, { action: back, ms: 15000 });
  };

  const overlapRow = (o, i) => `
    <tr>
      <td><b>${escapeHtml(o.keeps.name)}</b> <span class="muted">and</span> <b>${escapeHtml(o.gives.name)}</b></td>
      <td class="num">${size(o.overlap_ha)}</td>
      <td class="small">${o.action === "tidy" ? `${escapeHtml(o.gives.name)} gives way` : '<span class="bad">Too big to fix blind — check by hand</span>'}</td>
      <td><button class="linkbtn" data-ov="${i}">Show</button></td>
    </tr>`;

  const changeRow = (c) => `
    <tr>
      <td><b>${escapeHtml(c.name)}</b><div class="muted tiny">gives ground to ${c.gives_to.map(escapeHtml).join(", ")}</div></td>
      <td class="num">${nf(c.before_ha)} ha</td>
      <td class="num">${nf(c.after_ha)} ha</td>
      <td class="num">${c.after_ha === c.before_ha ? "under 0.01 ha" : `−${nf(c.before_ha - c.after_ha)} ha`}</td>
    </tr>`;

  const shapeRow = (s, i) => `
    <li><b>${escapeHtml(s.name)}</b>:
      ${s.crossings.length ? `crosses itself ${s.crossings.length === 1 ? "once" : `${s.crossings.length} times`}` : ""}
      ${s.crossings.length && s.spikes.length ? " and " : ""}
      ${s.spikes.length ? `doubles back at ${s.spikes.length === 1 ? "one corner" : `${s.spikes.length} corners`}` : ""}
      <button class="linkbtn" data-shape="${i}">Show</button></li>`;

  d.innerHTML = `
    <div class="dlg wide report">
      <header>
        <h2>Tidy paddock boundaries</h2>
        <div class="muted small">${p.paddocks} paddocks checked.</div>
      </header>
      <div class="body">
        ${p.shapes.length ? `
          <h3>Boundaries that cross themselves</h3>
          <p class="small">These need fixing by hand: select the paddock on the map, press <b>Reshape</b>, and drag the corners so the line doesn't cross over (or remove the spike's corner with a right-click, or a long-press on the phone). FORAGE and Cibo Labs can't read a boundary like this.</p>
          <ul class="small">${p.shapes.map(shapeRow).join("")}</ul>` : `
          <p class="small">✓ No boundary crosses itself or doubles back.</p>`}

        <h3>Overlapping paddocks</h3>
        ${p.overlaps.length ? `
          <p class="small">Where two paddocks were drawn along the same fence, their edges overlap a little. Together these overlaps cover <b>${size(p.total_overlap_ha)}</b>, counted twice in the property's area.
            The tidy-up gives each small overlap to the <b>smaller</b> paddock, and the larger paddock's edge is moved to match. The smaller one is usually the one drawn carefully along that fence, and a few square metres matter less to a big paddock.</p>
          <table class="list"><thead><tr><th>Paddocks</th><th class="num">Overlap</th><th>What happens</th><th></th></tr></thead>
            <tbody>${p.overlaps.map(overlapRow).join("")}</tbody></table>
          <div class="btns"><button class="btn" id="tdShowAll">Show all overlaps on the map</button></div>` : `
          <p class="small">✓ No paddocks overlap.</p>`}

        ${p.changes.length ? `
          <h3>What the tidy-up will change</h3>
          <p class="small">${p.changes.length} paddock${p.changes.length === 1 ? "" : "s"} get${p.changes.length === 1 ? "s" : ""} a slightly smaller boundary. Nothing else changes: mobs, gates, grazing records and pasture readings stay as they are.</p>
          <table class="list"><thead><tr><th>Paddock</th><th class="num">Now</th><th class="num">After</th><th class="num">Change</th></tr></thead>
            <tbody>${p.changes.map(changeRow).join("")}</tbody></table>` : ""}
        ${p.skipped.length ? `<div class="note small">Left alone, because it couldn't be done cleanly: ${p.skipped.map((s) => `${escapeHtml(s.name)} (${escapeHtml(s.reason)})`).join("; ")}.</div>` : ""}
        ${toCheck.length ? `<div class="note small">${toCheck.length} overlap${toCheck.length === 1 ? " is" : "s are"} too big to fix without looking (more than 2 ha, or more than a tenth of the smaller paddock). Use <b>Show</b> to see ${toCheck.length === 1 ? "it" : "them"}, then reshape by hand.</div>` : ""}
        ${p.last_tidy ? `<p class="muted small">Last tidy-up: ${when(p.last_tidy.at)}${p.last_tidy.username ? ` by ${escapeHtml(p.last_tidy.username)}` : ""}, ${p.last_tidy.count} paddock${p.last_tidy.count === 1 ? "" : "s"}. <button class="linkbtn" id="tdUndo">Undo it</button></p>` : ""}
        <p class="muted tiny">Every boundary change is kept in the paddock's history (select a paddock, then History). Overlaps under 10 m² are ignored as rounding.</p>
      </div>
      <footer>
        <span class="grow"></span>
        <button class="btn" id="tdClose">Close</button>
        ${p.changes.length ? `<button class="btn primary" id="tdApply">Tidy ${p.changes.length} paddock${p.changes.length === 1 ? "" : "s"}</button>` : ""}
      </footer>
    </div>`;

  d.querySelector("#tdClose").onclick = () => d.close();
  d.querySelectorAll("[data-ov]").forEach((b) => {
    b.onclick = () => {
      const o = p.overlaps[Number(b.dataset.ov)];
      goTo([o.geometry], [], `Overlap of ${o.keeps.name} and ${o.gives.name}, in red: ${size(o.overlap_ha)}`);
    };
  });
  d.querySelectorAll("[data-shape]").forEach((b) => {
    b.onclick = () => {
      const s = p.shapes[Number(b.dataset.shape)];
      goTo([], [...s.crossings, ...s.spikes], `${s.name}: the orange rings mark where the boundary crosses or doubles back`);
    };
  });
  const all = d.querySelector("#tdShowAll");
  if (all) all.onclick = () => goTo(p.overlaps.map((o) => o.geometry), [], `All ${p.overlaps.length} overlaps, in red. Zoom in to see them: most are thin slivers along fences.`);

  const undo = d.querySelector("#tdUndo");
  if (undo) undo.onclick = async () => {
    if (!confirm("Put back the boundaries as they were before the last tidy-up?")) return;
    try {
      const r = await send("POST", "/api/boundaries/undo-tidy");
      await ctx.reloadMap();
      ctx.toast(`Put back ${r.restored} paddock boundar${r.restored === 1 ? "y" : "ies"}${r.left.length ? `. Left as they are, because they were reshaped since: ${r.left.join(", ")}` : ""}`);
      openTidy(ctx);
    } catch (e) { ctx.toast(e.message, { error: true }); }
  };

  const apply = d.querySelector("#tdApply");
  if (apply) apply.onclick = async () => {
    apply.disabled = true;
    try {
      const r = await send("POST", "/api/boundaries/tidy", { revs: Object.fromEntries(p.changes.map((c) => [c.id, c.rev])) });
      await ctx.reloadMap();
      d.close();
      ctx.toast(`Tidied ${r.changed} paddock boundaries. ${r.plan.overlaps.length ? `${r.plan.overlaps.length} overlap${r.plan.overlaps.length === 1 ? "" : "s"} left to check by hand.` : "No overlaps left."}`, {
        ms: 12000,
        action: { label: "Undo", run: async () => {
          try {
            const u = await send("POST", "/api/boundaries/undo-tidy");
            await ctx.reloadMap();
            ctx.toast(`Put back ${u.restored} paddock boundaries`);
          } catch (e) { ctx.toast(e.message, { error: true }); }
        } },
      });
    } catch (e) {
      apply.disabled = false;
      ctx.toast(e.message, { error: true });
    }
  };
}
