/**
 * "Find gates that were probably left open": the model's suggestions for
 * gates that were open before this app kept records, with the evidence for
 * each, to tick and record. Everything recorded from here is marked inferred.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-AU")}`;
const lastDay = (to) => {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export async function openGateFinder(dialog, { toast, done }) {
  dialog.innerHTML = `
    <div class="dlg">
      <header><h2>Gates probably left open</h2></header>
      <div class="body"><p>Checking every gate against the pasture readings…</p>
        <p class="muted small">This runs the pasture model for each stretch, so it takes about ten seconds.</p></div>
      <footer><span class="grow"></span><button class="btn" id="close">Cancel</button></footer>
    </div>`;
  dialog.querySelector("#close").onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();

  let data;
  try {
    data = await get("/api/pasture/gate-suggestions");
  } catch (e) {
    dialog.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!dialog.open) return;
  const list = data.suggestions;
  if (!list.length) {
    dialog.querySelector(".body").innerHTML = `<p>No gates stand out. Nothing in the pasture readings before ${day(data.before)} points to a gate having been open that wasn't recorded.</p>`;
    return;
  }

  dialog.innerHTML = `
    <div class="dlg">
      <header>
        <h2>Gates probably left open</h2>
        <div class="muted small">${list.length} found in the pasture readings before ${day(data.before)}, when this app began keeping records</div>
      </header>
      <div class="body">
        <p class="small">For each stretch with stock on one side of a gate and none recorded on the other, the model was run both ways and checked against what PastureKey measured on <b>both</b> sides. These are where "open" fits clearly better.</p>
        <div class="note small">Anything recorded from here is marked <b>inferred</b> in the gate history and grazing records: likely, but worked out after the fact, not recorded at the time. Where you know better, leave it unticked.</div>
        <ul class="gatefind">${list.map((c, i) => `
          <li>
            <label class="pick">
              <input type="checkbox" data-i="${i}" ${c.confidence === "strong" ? "checked" : ""}>
              <span>
                <b>${escapeHtml(c.stocked_name)} ↔ ${escapeHtml(c.other_name)}</b>
                <span class="chip ${c.confidence === "strong" ? "strongchip" : ""}">${c.confidence}</span>
                <span class="muted small">${escapeHtml(c.gate_name)}</span><br>
                <span class="small">${day(c.from)} to ${day(lastDay(c.to))} · ${escapeHtml(c.mobs.join(", ") || "stock")} in ${escapeHtml(c.stocked_name)} (${c.ae.toLocaleString("en-AU")} AE)</span><br>
                <span class="muted tiny">${escapeHtml(c.other_name)} changed ${signed(c.other_change.measured)} kg/ha. Rested, the model expects ${signed(c.other_change.if_rested)}; sharing the stock, ${signed(c.other_change.if_open)}. Paddocks that really were rested ran ${signed(-c.rested_drift)} against the model then, and this one lost ${c.excess.toLocaleString("en-AU")} kg/ha more than that. "Open" fits both paddocks ${c.improvement}% better.</span>
              </span>
            </label>
          </li>`).join("")}
        </ul>
      </div>
      <footer>
        <span class="grow small" id="count"></span>
        <button class="btn" id="close">Cancel</button>
        <button class="btn primary" id="save">Record as inferred</button>
      </footer>
    </div>`;
  dialog.querySelector("#close").onclick = () => dialog.close();
  const boxes = [...dialog.querySelectorAll("[data-i]")];
  const count = () => {
    const n = boxes.filter((b) => b.checked).length;
    dialog.querySelector("#count").textContent = `${n} ticked`;
    dialog.querySelector("#save").disabled = n === 0;
  };
  boxes.forEach((b) => b.addEventListener("change", count));
  count();

  dialog.querySelector("#save").onclick = async () => {
    const btn = dialog.querySelector("#save");
    btn.disabled = true;
    const items = boxes.filter((b) => b.checked).map((b) => {
      const c = list[Number(b.dataset.i)];
      return { gate_id: c.gate_id, stocked: c.stocked, from: c.from, to: c.to };
    });
    try {
      const r = await send("POST", "/api/pasture/inferred-gates", { items });
      dialog.close();
      const skipped = r.skipped.length ? ` (${r.skipped.length} skipped: ${r.skipped[0].reason})` : "";
      done(`Recorded ${r.recorded} gate opening${r.recorded === 1 ? "" : "s"} as inferred${skipped}`, r.batch);
    } catch (e) {
      btn.disabled = false;
      toast(e.message, { error: true });
    }
  };
}
