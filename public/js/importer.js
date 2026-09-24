/**
 * Import a map file: upload, review what it contains, then add the chosen
 * shapes to the map.
 *
 * The review step is the point. Every shape arrives with a suggested kind and
 * name, grouped by the folder or layer it came from, and nothing is written
 * until the list has been looked at and confirmed. Shapes that already appear
 * to be on the map are unticked, so re-importing an export does not double it.
 */
import { upload, send } from "./api.js";
import { escapeHtml } from "./map.js";

const GEOM_CLASS = {
  Point: "point", LineString: "line", MultiLineString: "line", Polygon: "polygon", MultiPolygon: "polygon",
};

const fmtArea = (c) =>
  c.area_ha != null ? `${c.area_ha.toLocaleString("en-AU", { maximumFractionDigits: 1 })} ha`
    : c.length_m != null ? `${(c.length_m / 1000).toLocaleString("en-AU", { maximumFractionDigits: 2 })} km`
    : "";

/**
 * What the picker says for each way in. The review screens are the same
 * whichever button was used — a file is recognised by its contents — but
 * the words and the file types offered match what was asked for.
 */
const PICKERS = {
  any: {
    title: "Import",
    accept: ".json,.geojson,.kml,.kmz,.zip,.xlsx,.csv",
    help: `Maps: AgriWebb map export (.json), Google Earth (.kml / .kmz), a zipped shapefile (.zip) or GeoJSON.<br>
      Records: AgriWebb exports (.xlsx).<br>
      Cattle: a session from the scales — Gallagher TSi, TWR-5 or APS (.csv).`,
  },
  map: {
    title: "Import a map",
    accept: ".json,.geojson,.kml,.kmz,.zip",
    help: "Paddocks, water points and gates: an AgriWebb map export (.json), Google Earth (.kml / .kmz), a zipped shapefile (.zip) or GeoJSON.",
  },
  records: {
    title: "Import AgriWebb records",
    accept: ".xlsx",
    help: "An export from AgriWebb (.xlsx): the mob list, the paddock list, the Movement records report or the rainfall report.",
  },
  session: {
    title: "Import a cattle session",
    accept: ".csv",
    help: `A weighing or processing session from the scales — Gallagher TSi, TWR-5 or APS — saved as a .csv file.<br>
      Each animal's EID, tag, weight and notes come in, and you choose which mob they belong to.`,
  },
};

export function openImport(dialog, meta, onDone, { kind = "any", mobId = null } = {}) {
  const kinds = meta.kinds;
  const picker = PICKERS[kind] || PICKERS.any;

  function kindOptions(cls, selected) {
    return kinds
      .filter((k) => k.geoms.includes(cls))
      .map((k) => `<option value="${k.id}"${k.id === selected ? " selected" : ""}>${escapeHtml(k.label)}</option>`)
      .join("");
  }

  /* ------------------------------ step 1: pick ----------------------------- */

  function showPicker(error) {
    dialog.innerHTML = `
      <div class="dlg">
        <header><h2>${escapeHtml(picker.title)}</h2></header>
        <div class="body">
          ${error ? `<div class="note err">${escapeHtml(error)}</div>` : ""}
          <label class="drop" id="drop">
            <input type="file" id="file" accept="${picker.accept}" hidden>
            <p><b>Choose a file</b> or drop it here</p>
            <p class="muted">${picker.help}</p>
          </label>
          <p class="muted small gap-top">
            Nothing is added until you have reviewed it on the next screen.
          </p>
        </div>
        <footer><button class="btn" id="close">Cancel</button></footer>
      </div>`;
    dialog.querySelector("#close").onclick = () => dialog.close();
    const input = dialog.querySelector("#file");
    const drop = dialog.querySelector("#drop");
    input.onchange = () => input.files[0] && go(input.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer.files[0];
      if (f) go(f);
    };
  }

  async function go(file) {
    dialog.querySelector(".body").innerHTML = `<p>Reading <b>${escapeHtml(file.name)}</b>…</p>`;
    try {
      if (/\.(xlsx|csv)$/i.test(file.name)) {
        const preview = await upload("/api/import/records/preview", file);
        if (preview.type === "mobs") showMobReview(file.name, preview);
        else if (preview.type === "movements") showMovementReview(file.name, preview);
        else if (preview.type === "rainfall") showRainReview(file.name, preview);
        else if (preview.type === "session") showSessionReview(file.name, preview);
        else showPaddockCheck(file.name, preview);
        return;
      }
      const preview = await upload("/api/import/preview", file);
      showReview(file.name, preview);
    } catch (e) {
      showPicker(e.message);
    }
  }

  /* ----------------------------- step 2: review ---------------------------- */

  function showReview(filename, p) {
    const matches = p.matches || {};
    const rows = p.candidates.map((c) => ({
      c,
      cls: GEOM_CLASS[c.geometry.type],
      include: matches[c.i] === undefined,
      kind: c.kind,
      subtype: c.subtype || "",
      name: c.name,
      dup: matches[c.i] !== undefined,
    }));

    const groups = new Map();
    for (const r of rows) {
      const key = r.c.group || { point: "Points", line: "Lines", polygon: "Areas" }[r.cls];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const dupCount = rows.filter((r) => r.dup).length;
    const fmtLabel = { agriwebb: "AgriWebb map export", kml: "KML", kmz: "KMZ", shapefile: "Shapefile", geojson: "GeoJSON" }[p.format] || p.format;

    dialog.innerHTML = `
      <div class="dlg">
        <header>
          <h2>Review import</h2>
          <div class="muted small">
            ${escapeHtml(filename)} · ${escapeHtml(fmtLabel)} · ${rows.length} shapes
          </div>
        </header>
        <div class="body">
          ${p.format === "agriwebb" ? `<div class="note">
            Recognised as an AgriWebb export: paddocks, troughs, tanks, bores, dams and gates are
            already sorted. AgriWebb does not export fence lines — draw those here after importing.
          </div>` : ""}
          ${dupCount ? `<div class="note warn">${dupCount} shape${dupCount === 1 ? " looks" : "s look"} to be on the map already and ${dupCount === 1 ? "has" : "have"} been unticked.</div>` : ""}
          ${p.rejected.length ? `<details class="note err"><summary>${p.rejected.length} shape${p.rejected.length === 1 ? "" : "s"} could not be read</summary>
            <ul>${p.rejected.slice(0, 50).map((r) => `<li>${escapeHtml(r.name || "(unnamed)")} — ${escapeHtml(r.reason)}</li>`).join("")}</ul>
          </details>` : ""}
          <div class="groups" id="groups"></div>
        </div>
        <footer>
          <span class="grow" id="summary"></span>
          <button class="btn" id="back">Back</button>
          <button class="btn primary" id="commit">Import</button>
        </footer>
      </div>`;

    const subtypeLists = kinds.map((k) =>
      `<datalist id="st-${k.id}">${k.subtypes.map((s) => `<option value="${escapeHtml(s)}">`).join("")}</datalist>`
    ).join("");

    const groupsEl = dialog.querySelector("#groups");
    groupsEl.innerHTML = subtypeLists + [...groups.entries()].map(([name, rs], gi) => {
      const classes = [...new Set(rs.map((r) => r.cls))];
      const kindsInGroup = [...new Set(rs.map((r) => r.kind))];
      const bulk = classes.length === 1
        ? `<select data-bulk="${gi}" title="Set every shape in this group to">
             <option value="">Set all to…</option>${kindOptions(classes[0], "")}
           </select>`
        : "";
      return `
        <details class="group" ${groups.size <= 3 ? "open" : ""}>
          <summary>
            <input type="checkbox" data-gcheck="${gi}" ${rs.every((r) => r.include) ? "checked" : ""}>
            <b>${escapeHtml(name)}</b>
            <span class="chip">${rs.length}</span>
            <span class="muted">${kindsInGroup.map((k) => escapeHtml(kinds.find((x) => x.id === k)?.label || k)).join(", ")}</span>
            ${bulk}
          </summary>
          <table>
            ${rs.map((r) => `
              <tr class="${r.dup ? "dup" : ""}" data-i="${r.c.i}">
                <td class="w-chk"><input type="checkbox" data-inc ${r.include ? "checked" : ""}></td>
                <td><input type="text" data-name value="${escapeHtml(r.name)}" placeholder="(no name)"></td>
                <td class="w-kind"><select data-kind>${kindOptions(r.cls, r.kind)}</select></td>
                <td class="w-sub"><input type="text" data-subtype value="${escapeHtml(r.subtype)}" list="st-${r.kind}" placeholder="type"></td>
                <td class="muted w-size">${fmtArea(r.c)}${r.dup ? ' <span class="chip">on map</span>' : ""}</td>
              </tr>`).join("")}
          </table>
        </details>`;
    }).join("");

    const byI = new Map(rows.map((r) => [r.c.i, r]));
    const groupRows = [...groups.values()];

    const summary = () => {
      const n = rows.filter((r) => r.include).length;
      dialog.querySelector("#summary").textContent = `${n} of ${rows.length} selected`;
      dialog.querySelector("#commit").disabled = n === 0;
      dialog.querySelector("#commit").textContent = n ? `Import ${n}` : "Import";
    };

    groupsEl.addEventListener("input", (e) => {
      const tr = e.target.closest("tr[data-i]");
      if (!tr) return;
      const r = byI.get(Number(tr.dataset.i));
      if (e.target.matches("[data-inc]")) r.include = e.target.checked;
      if (e.target.matches("[data-name]")) r.name = e.target.value;
      if (e.target.matches("[data-subtype]")) r.subtype = e.target.value;
      if (e.target.matches("[data-kind]")) {
        r.kind = e.target.value;
        tr.querySelector("[data-subtype]").setAttribute("list", `st-${r.kind}`);
      }
      summary();
    });

    groupsEl.addEventListener("change", (e) => {
      if (e.target.matches("[data-gcheck]")) {
        const rs = groupRows[Number(e.target.dataset.gcheck)];
        for (const r of rs) {
          r.include = e.target.checked;
          groupsEl.querySelector(`tr[data-i="${r.c.i}"] [data-inc]`).checked = r.include;
        }
        summary();
      }
      if (e.target.matches("[data-bulk]") && e.target.value) {
        const rs = groupRows[Number(e.target.dataset.bulk)];
        for (const r of rs) {
          r.kind = e.target.value;
          const tr = groupsEl.querySelector(`tr[data-i="${r.c.i}"]`);
          tr.querySelector("[data-kind]").value = r.kind;
          tr.querySelector("[data-subtype]").setAttribute("list", `st-${r.kind}`);
        }
        e.target.value = "";
      }
    });
    // A click on the group checkbox must not also fold the group open or shut.
    groupsEl.querySelectorAll("summary input, summary select").forEach((el) => {
      el.addEventListener("click", (e) => e.stopPropagation());
    });

    dialog.querySelector("#back").onclick = () => showPicker();
    dialog.querySelector("#commit").onclick = async () => {
      const btn = dialog.querySelector("#commit");
      btn.disabled = true;
      btn.textContent = "Importing…";
      try {
        const items = rows.filter((r) => r.include).map((r) => ({
          i: r.c.i, kind: r.kind, name: r.name, subtype: r.subtype,
        }));
        const res = await send("POST", `/api/import/${p.importId}/commit`, { items });
        dialog.close();
        onDone(`Imported ${res.created} shape${res.created === 1 ? "" : "s"}`);
      } catch (e) {
        btn.disabled = false;
        summary();
        dialog.querySelector(".body").insertAdjacentHTML("afterbegin", `<div class="note err">${escapeHtml(e.message)}</div>`);
        dialog.querySelector(".body").scrollTop = 0;
      }
    };
    summary();
  }

  /* -------------------------- step 2: mob list review ---------------------- */

  function showMobReview(filename, p) {
    const matches = p.matches || {};
    const rows = p.mobs.map((m) => ({
      m, include: matches[m.i] === undefined, name: m.name, owner: m.owner || "", sex: m.sex || "",
      dup: matches[m.i] !== undefined,
    }));
    const head = rows.reduce((s, r) => s + r.m.head, 0);
    const warned = rows.filter((r) => r.m.warnings.length).length;
    const dupCount = rows.filter((r) => r.dup).length;
    const plural = (n, one, many) => (n === 1 ? one : many);

    dialog.innerHTML = `
      <div class="dlg">
        <header>
          <h2>Review mobs</h2>
          <div class="muted small">${escapeHtml(filename)} · ${rows.length} mobs · ${head.toLocaleString()} head · as at ${escapeHtml(p.asOf)}</div>
        </header>
        <div class="body">
          <div class="note">
            This is where each mob is <b>today</b>, not its history. It becomes each mob's starting point;
            moves recorded here from now on build on it.
            Set an <b>owner</b> on agistment cattle so they are kept apart from your own herd numbers.
          </div>
          ${dupCount ? `<div class="note warn">${dupCount} ${plural(dupCount, "mob was", "mobs were")} already imported from an earlier export and ${plural(dupCount, "has", "have")} been unticked.</div>` : ""}
          ${warned ? `<div class="note warn">${warned} ${plural(warned, "mob has", "mobs have")} something worth checking — see the notes underneath.</div>` : ""}
          <table class="list mobs-review">
            <thead><tr><th></th><th>Mob</th><th class="num">Head</th><th>Weight</th><th>Paddocks</th><th>Sex</th><th>Owner</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr data-i="${r.m.i}" class="${r.dup ? "dup" : ""}">
                <td class="w-chk"><input type="checkbox" data-inc ${r.include ? "checked" : ""}></td>
                <td><input type="text" data-name value="${escapeHtml(r.name)}">
                  <div class="muted tiny">${escapeHtml([r.m.breed, r.m.age_class, r.m.origin].filter(Boolean).join(" · "))}${r.m.birth_date ? ` · born ${escapeHtml(r.m.birth_date)}` : ""}</div></td>
                <td class="num">${r.m.head}</td>
                <td class="nowrap">${r.m.weight_kg != null ? `${Math.round(r.m.weight_kg)} kg` : "—"}<div class="muted tiny">${escapeHtml(r.m.last_weighed || "")}</div></td>
                <td>${r.m.paddock_names.map((n) => r.m.unmatched_paddocks.includes(n) ? `<span class="bad">${escapeHtml(n)}</span>` : escapeHtml(n)).join(", ")}</td>
                <td><select data-sex>
                  ${["", "female", "steer", "male"].map((v) => `<option value="${v}"${v === r.sex ? " selected" : ""}>${v || "mixed / ?"}</option>`).join("")}
                </select></td>
                <td><input type="text" data-owner value="${escapeHtml(r.owner)}" placeholder="own stock"></td>
              </tr>
              ${r.m.warnings.length ? `<tr class="warnrow"><td></td><td colspan="6">${r.m.warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join("")}</td></tr>` : ""}`).join("")}
            </tbody>
          </table>
        </div>
        <footer>
          <span class="grow" id="summary"></span>
          <button class="btn" id="back">Back</button>
          <button class="btn primary" id="commit">Import</button>
        </footer>
      </div>`;

    const byI = new Map(rows.map((r) => [r.m.i, r]));
    const summary = () => {
      const sel = rows.filter((r) => r.include);
      const all = sel.reduce((s, r) => s + r.m.head, 0);
      const agist = sel.filter((r) => r.owner.trim()).reduce((s, r) => s + r.m.head, 0);
      dialog.querySelector("#summary").textContent =
        `${sel.length} mobs · ${(all - agist).toLocaleString()} own head${agist ? ` · ${agist.toLocaleString()} agisted` : ""}`;
      dialog.querySelector("#commit").disabled = sel.length === 0;
    };
    dialog.querySelector("tbody").addEventListener("input", (e) => {
      const tr = e.target.closest("tr[data-i]");
      if (!tr) return;
      const r = byI.get(Number(tr.dataset.i));
      if (e.target.matches("[data-inc]")) r.include = e.target.checked;
      if (e.target.matches("[data-name]")) r.name = e.target.value;
      if (e.target.matches("[data-owner]")) r.owner = e.target.value;
      if (e.target.matches("[data-sex]")) r.sex = e.target.value;
      summary();
    });
    dialog.querySelector("#back").onclick = () => showPicker();
    dialog.querySelector("#commit").onclick = async () => {
      const btn = dialog.querySelector("#commit");
      btn.disabled = true;
      btn.textContent = "Importing…";
      try {
        const items = rows.filter((r) => r.include).map((r) => ({ i: r.m.i, name: r.name, owner: r.owner, sex: r.sex }));
        const res = await send("POST", `/api/import/records/${p.importId}/commit`, { items });
        dialog.close();
        onDone(`Imported ${res.summary}`);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Import";
        dialog.querySelector(".body").insertAdjacentHTML("afterbegin", `<div class="note err">${escapeHtml(e.message)}</div>`);
        dialog.querySelector(".body").scrollTop = 0;
      }
    };
    summary();
  }

  /* ---------------------- step 2: session from the scales ------------------- */

  function showSessionReview(filename, p) {
    const fmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—");
    const eid = (e) => (e && e.length === 15 ? `${e.slice(0, 3)} ${e.slice(3)}` : e || "");
    // Only pre-select a mob when one clearly leads; two close candidates are
    // for you to choose between, not for the app to guess.
    const [first, second] = p.suggestions;
    const clear = !mobId && first && (!second || first.score - second.score >= 15);
    const others = (p.allMobs || []).filter((m) => !p.suggestions.some((sg) => sg.mob_id === m.id));

    dialog.innerHTML = `
      <div class="dlg">
        <header>
          <h2>Review session</h2>
          <div class="muted small">${escapeHtml(filename)} · ${p.count} animals${p.mean_kg ? ` · average ${Math.round(p.mean_kg)} kg` : ""}</div>
        </header>
        <div class="body">
          <div class="row2">
            <div class="f"><label for="sName">Session</label><input id="sName" value="${escapeHtml(p.name)}" autocomplete="off"></div>
            <div class="f"><label for="sDate">Date</label><input id="sDate" type="date" value="${p.date || ""}"></div>
          </div>
          <p class="small">${p.new_animals ? `<b>${p.new_animals}</b> new animal${p.new_animals === 1 ? "" : "s"} will be created` : "No new animals"}${p.existing ? `; <b>${p.existing}</b> already have records and get this weighing added` : ""}.</p>

          <h3>Which mob are they in?</h3>
          ${p.suggestions.length && !clear ? '<div class="note warn">More than one mob fits. Check the reasons and choose.</div>' : ""}
          <div class="choices">
            ${p.suggestions.map((sg, i) => `
              <label class="choice">
                <input type="radio" name="sMob" value="${sg.mob_id}" ${clear && i === 0 ? "checked" : ""}>
                <span><b>${escapeHtml(sg.name)}</b> <span class="muted">${sg.head} hd${sg.weight_kg ? ` · ${Math.round(sg.weight_kg)} kg` : ""}</span>
                <br><span class="muted tiny">${sg.reasons.map(escapeHtml).join(" · ")}</span></span>
              </label>`).join("")}
            ${others.length ? `<label class="choice"><input type="radio" name="sMob" value="other"><span>Another mob
              <select id="sOther"><option value="">choose…</option>${others.map((m) => `<option value="${m.id}">${escapeHtml(m.name)} (${m.head} hd)</option>`).join("")}</select></span></label>` : ""}
            <label class="choice"><input type="radio" name="sMob" value=""><span>Don't put them in a mob yet</span></label>
          </div>
          <label class="radio gap-top"><input type="checkbox" id="sWeight" checked> Set the mob's average weight from this session</label>
          <p class="muted tiny" id="sWeightNote"></p>

          <details class="gap-top"><summary class="small">The ${p.count} animals</summary>
            <table class="list"><thead><tr><th>Tag</th><th>EID</th><th class="num">Weight</th><th></th></tr></thead><tbody>
              ${p.rows.map((r) => `<tr><td>${escapeHtml(r.tag || "")}</td><td class="muted small">${escapeHtml(eid(r.eid))}</td>
                <td class="num">${r.weight_kg != null ? `${r.weight_kg} kg` : ""}</td>
                <td class="muted small">${r.animal_id ? `known${r.current_mob ? ` · ${escapeHtml(r.current_mob)}` : ""}` : "new"}${r.notes ? ` · ${escapeHtml(r.notes)}` : ""}</td></tr>`).join("")}
            </tbody></table>
          </details>
        </div>
        <footer>
          <span class="grow" id="summary"></span>
          <button class="btn" id="back">Back</button>
          <button class="btn primary" id="commit">Import session</button>
        </footer>
      </div>`;

    const chosen = () => {
      const r = dialog.querySelector('input[name="sMob"]:checked');
      if (!r) return undefined;
      if (r.value === "other") return dialog.querySelector("#sOther").value ? Number(dialog.querySelector("#sOther").value) : undefined;
      return r.value === "" ? null : Number(r.value);
    };
    const update = () => {
      const mob = chosen();
      dialog.querySelector("#commit").disabled = mob === undefined;
      dialog.querySelector("#summary").textContent = mob === undefined ? "Choose a mob, or none" : "";
      const w = dialog.querySelector("#sWeight");
      w.disabled = !mob;
      const later = mob ? p.later_weighing[mob] : null;
      dialog.querySelector("#sWeightNote").textContent = later
        ? `This mob has a later weighing (${Math.round(later.weight_kg)} kg on ${fmt(later.date)}), which stays its current weight.`
        : "";
    };
    dialog.querySelectorAll('input[name="sMob"]').forEach((r) => r.addEventListener("change", update));
    if (mobId) {
      const listed = dialog.querySelector(`input[name="sMob"][value="${mobId}"]`);
      if (listed) listed.checked = true;
      else if (dialog.querySelector("#sOther")) {
        dialog.querySelector("#sOther").value = String(mobId);
        dialog.querySelector('input[name="sMob"][value="other"]').checked = true;
      }
    }
    dialog.querySelector("#sOther")?.addEventListener("change", () => {
      dialog.querySelector('input[name="sMob"][value="other"]').checked = true;
      update();
    });
    dialog.querySelector("#back").onclick = () => showPicker();
    dialog.querySelector("#commit").onclick = async () => {
      const btn = dialog.querySelector("#commit");
      btn.disabled = true;
      btn.textContent = "Importing…";
      try {
        const mob = chosen();
        const res = await send("POST", `/api/import/records/${p.importId}/commit`, {
          mob_id: mob, name: dialog.querySelector("#sName").value, date: dialog.querySelector("#sDate").value || null,
          update_mob_weight: !!mob && dialog.querySelector("#sWeight").checked,
        });
        dialog.close();
        onDone(`Imported ${res.summary}`, res.batch);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Import session";
        dialog.querySelector(".body").insertAdjacentHTML("afterbegin", `<div class="note err">${escapeHtml(e.message)}</div>`);
        dialog.querySelector(".body").scrollTop = 0;
      }
    };
    update();
  }

  /* --------------------------- step 2: rainfall ---------------------------- */

  function showRainReview(filename, p) {
    const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
    const dups = p.gauges.reduce((t, g) => t + g.duplicates, 0);
    dialog.innerHTML = `
      <div class="dlg">
        <header>
          <h2>Review rainfall</h2>
          <div class="muted small">${escapeHtml(filename)} · ${p.readings} readings · ${fmt(p.first)} to ${fmt(p.last)}</div>
        </header>
        <div class="body">
          ${dups ? `<div class="note warn">${dups} reading${dups === 1 ? " is" : "s are"} already recorded and will be skipped.</div>` : ""}
          <h3>Gauges</h3>
          <p class="muted small">AgriWebb calls a gauge with no name "Unknown". Give it the name you want it kept under.</p>
          <table class="list">
            <thead><tr><th>In AgriWebb</th><th>Keep as</th><th class="num">Readings</th><th class="num">Total</th></tr></thead>
            <tbody>${p.gauges.map((g) => `
              <tr><td>${escapeHtml(g.name)}</td>
                <td><input type="text" class="cellinput" data-gauge="${escapeHtml(g.name)}" value="${g.name === "Unknown" ? "" : escapeHtml(g.name)}" placeholder="${g.name === "Unknown" ? "e.g. Homestead" : ""}"></td>
                <td class="num">${g.readings}</td><td class="num">${Math.round(g.mm)} mm</td></tr>`).join("")}
            </tbody>
          </table>
          <details class="gap-top"><summary class="small">All ${p.readings} readings</summary>
            <table class="list"><tbody>${p.rows.map((r) => `
              <tr><td>${fmt(r.date)}${r.time ? ` <span class="muted">${escapeHtml(r.time)}</span>` : ""}</td><td class="muted">${escapeHtml(r.gauge)}</td><td class="num">${r.mm} mm</td></tr>`).join("")}
            </tbody></table>
          </details>
        </div>
        <footer>
          <span class="grow" id="summary"></span>
          <button class="btn" id="back">Back</button>
          <button class="btn primary" id="commit">Import</button>
        </footer>
      </div>`;
    const inputs = [...dialog.querySelectorAll("[data-gauge]")];
    const check = () => {
      const missing = inputs.some((i) => !i.value.trim());
      dialog.querySelector("#commit").disabled = missing;
      dialog.querySelector("#summary").textContent = missing ? "Name each gauge to continue" : "";
    };
    inputs.forEach((i) => i.addEventListener("input", check));
    dialog.querySelector("#back").onclick = () => showPicker();
    dialog.querySelector("#commit").onclick = async () => {
      const btn = dialog.querySelector("#commit");
      btn.disabled = true;
      try {
        const gauges = Object.fromEntries(inputs.map((i) => [i.dataset.gauge, i.value.trim()]));
        const res = await send("POST", `/api/import/records/${p.importId}/commit`, { gauges });
        dialog.close();
        onDone(`Imported ${res.summary}`);
      } catch (e) {
        btn.disabled = false;
        dialog.querySelector(".body").insertAdjacentHTML("afterbegin", `<div class="note err">${escapeHtml(e.message)}</div>`);
      }
    };
    check();
  }

  /* ------------------------ step 2: movement history ------------------------ */

  function showMovementReview(filename, p) {
    const fmtDate = (at) => at ? new Date(`${at.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
    const plan = p.plan;
    const ended = Object.entries(p.ended).map(([why, n]) => {
      const label = { Sale: "sold out", Death: "lost to deaths", "Draft/Split": "merged into other mobs", "Transfer off farm": "transferred off" }[why] || why;
      return `${n} ${label}`;
    }).join(", ");
    const problems = [
      ...plan.unknown_paddocks.map((n) => `Paddock "${n}" is not on the map.`),
      ...plan.unmatched_live.map((n) => `The history ends with ${n}, which is not in the current mob list.`),
      ...plan.unmatched_mobs.map((n) => `${n} is in the mob list but the history never arrives at it.`),
    ];
    const eventLabels = {
      Move: "moves", "Draft/Split": "drafts and splits", Merge: "merges", Sale: "sales", Death: "deaths",
      Purchased: "purchases", Recount: "recounts", Weigh: "weighings", "Transfer off farm": "transfers off farm",
    };

    dialog.innerHTML = `
      <div class="dlg">
        <header>
          <h2>Review movement history</h2>
          <div class="muted small">${escapeHtml(filename)} · ${p.records} records · ${fmtDate(p.first)} to ${fmtDate(p.last)}</div>
        </header>
        <div class="body">
          ${p.alreadyImported ? `<div class="note warn">Movement history has already been imported. Importing it again would double every event, so it is blocked.</div>` : ""}
          ${problems.length
            ? `<div class="note err">The history does not line up with the current mobs, so nothing can be imported yet:<ul>${problems.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
               The mob list and the movement report need to be exported on the same day.</div>`
            : `<div class="note good">Every record traced to a mob. The ${p.live} mobs still on hand at the end of the history
               match the current mob list exactly — head for head, paddock for paddock.</div>`}
          <dl class="facts">
            <dt>Mobs traced</dt><dd>${p.mobs}: ${p.live} still on hand${ended ? `; ${escapeHtml(ended)}` : ""}</dd>
            <dt>Records</dt><dd>${Object.entries(p.counts).filter(([k]) => eventLabels[k]).map(([k, n]) => `${n} ${eventLabels[k]}`).join(", ")}</dd>
          </dl>
          ${p.notes.length ? `<details class="note warn"><summary>${p.notes.length} record${p.notes.length === 1 ? "" : "s"} needed interpreting</summary><ul>${p.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></details>` : ""}
          <p class="small">Importing adds each mob's history behind what you already have: past mobs that were sold
          or merged are kept as closed records, and every paddock gets its grazing and rest history.</p>
          <p class="muted small">Not in AgriWebb's report, so not imported: the weights from each weighing,
          and gates left open across several paddocks — each record names a single paddock.</p>
        </div>
        <footer>
          <button class="btn" id="back">Back</button>
          <button class="btn primary" id="commit"${p.canImport ? "" : " disabled"}>Import history</button>
        </footer>
      </div>`;
    dialog.querySelector("#back").onclick = () => showPicker();
    dialog.querySelector("#commit").onclick = async () => {
      const btn = dialog.querySelector("#commit");
      btn.disabled = true;
      btn.textContent = "Importing…";
      try {
        const res = await send("POST", `/api/import/records/${p.importId}/commit`, {});
        dialog.close();
        onDone(`Imported ${res.summary}`);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Import history";
        dialog.querySelector(".body").insertAdjacentHTML("afterbegin", `<div class="note err">${escapeHtml(e.message)}</div>`);
      }
    };
  }

  /* ------------------------- step 2: paddock list check --------------------- */

  function showPaddockCheck(filename, p) {
    const bad = p.rows.filter((r) => r.checks.length);
    const notes = p.rows.filter((r) => r.paddock_id !== null && r.description);
    const stocked = p.rows.filter((r) => r.cattle);
    const f0 = (n) => (n == null ? "—" : n.toFixed(0));
    const f2 = (n) => (n == null ? "—" : n.toFixed(2));

    dialog.innerHTML = `
      <div class="dlg">
        <header>
          <h2>Paddock list check</h2>
          <div class="muted small">${escapeHtml(filename)} · ${p.rows.length} paddocks · as at ${escapeHtml(p.asOf)}</div>
        </header>
        <div class="body">
          <div class="note">
            AgriWebb's paddock list is worked out from its map and mob list, so it is used here as a
            <b>check</b>: do the paddocks match the map, and do the stock numbers agree?
          </div>
          ${bad.length === 0
            ? `<div class="note good">All ${p.rows.length} paddocks match the map${stocked.length ? ", and head and AE agree with the mob list on every stocked paddock" : ""}.</div>`
            : `<div class="note warn">${bad.length} paddock${bad.length === 1 ? " disagrees" : "s disagree"}:<ul>${bad.map((r) => `<li><b>${escapeHtml(r.name)}</b>: ${r.checks.map(escapeHtml).join("; ")}</li>`).join("")}</ul></div>`}
          ${p.missingFromSheet.length ? `<div class="note warn">On the map but not in the list: ${p.missingFromSheet.map(escapeHtml).join(", ")}</div>` : ""}
          ${stocked.length ? `
            <h3 class="gap-top">Stocked paddocks</h3>
            <table class="list">
              <thead><tr><th>Paddock</th><th class="num">Head</th><th class="num">AgriWebb AE</th><th class="num">AE by weight</th><th class="num">AgriWebb AE/ha</th><th class="num">AE/ha by weight</th></tr></thead>
              <tbody>${stocked.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.cattle}</td>
                <td class="num">${f0(r.ae)}</td><td class="num">${f0(r.ae_here)}</td>
                <td class="num">${f2(r.ae_per_ha)}</td><td class="num">${f2(r.ae_per_ha_here)}</td></tr>`).join("")}
              </tbody>
            </table>
            <p class="muted small">AgriWebb counts every animal over weaner age as 1 AE whatever it weighs. "By weight" scales each mob by liveweight (a 450 kg steer = 1 AE), which is what the pasture projections will use.</p>` : ""}
          ${notes.length ? `<p class="small gap-top">${notes.length} paddock${notes.length === 1 ? " has a description" : "s have descriptions"} in AgriWebb that can be added as notes where the paddock has none.</p>` : ""}
        </div>
        <footer>
          <button class="btn" id="back">Back</button>
          ${notes.length ? `<button class="btn primary" id="commit">Add notes</button>` : `<button class="btn primary" id="close">Done</button>`}
        </footer>
      </div>`;
    dialog.querySelector("#back").onclick = () => showPicker();
    const close = dialog.querySelector("#close");
    if (close) close.onclick = () => dialog.close();
    const commit = dialog.querySelector("#commit");
    if (commit) commit.onclick = async () => {
      commit.disabled = true;
      try {
        const res = await send("POST", `/api/import/records/${p.importId}/commit`, {});
        dialog.close();
        onDone(res.summary);
      } catch (e) {
        commit.disabled = false;
        dialog.querySelector(".body").insertAdjacentHTML("afterbegin", `<div class="note err">${escapeHtml(e.message)}</div>`);
      }
    };
  }

  showPicker();
  dialog.showModal();
}
