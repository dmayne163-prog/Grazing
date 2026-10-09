/**
 * The NLIS check: where the NLIS record for the PIC and the app disagree, as
 * lists to work through — tags NLIS still holds here that the app shows as
 * gone (record the death or transfer in NLIS), tags it holds that the app
 * doesn't know, animals here that aren't in a mob, and animals on hand here
 * that NLIS says left. Each list exports to CSV.
 */
import { get } from "./api.js";
import { escapeHtml } from "./map.js";

const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—");
const eidText = (e) => (e ? e.replace(/^(\d{3})(\d+)$/, "$1 $2") : "");
const STATUS = { sold: "sold", dead: "dead", gone: "off the books" };

const LISTS = [
  ["ended", "NLIS holds them here; the app has them as gone",
    "Most likely dead or sold without the NLIS transfer. Record the death (or the transfer) in NLIS.",
    [["eid", "EID"], ["tag", "Tag"], ["from_pic", "Came from"], ["arrived", "Arrived"], ["app_status", "App"], ["last_seen", "Last seen here"]]],
  ["no_mob", "NLIS holds them here; in the app but not in any mob",
    "Probably still here: put them in their mob from the Animals tab (Not in a mob).",
    [["eid", "EID"], ["tag", "Tag"], ["from_pic", "Came from"], ["arrived", "Arrived"], ["last_seen", "Last seen here"]]],
  ["unknown", "NLIS holds them here; the app has no record of them",
    "Never scanned here, or before the scales records. Check at the next muster; if they're gone, record it in NLIS.",
    [["eid", "EID"], ["nlis_id", "NLIS ID"], ["from_pic", "Came from"], ["arrived", "Arrived"]]],
  ["conflicts", "On hand in a mob here; NLIS says they left",
    "Either they came back without a transfer onto the PIC, or the mob record is wrong. Check these first.",
    [["eid", "EID"], ["tag", "Tag"], ["mob", "Mob"], ["to_pic", "NLIS: moved to"], ["date", "On"]]],
];

export async function openNlisCheck(ctx) {
  const d = ctx.dialog;
  d.innerHTML = '<div class="dlg wide"><div class="body"><p>Checking…</p></div></div>';
  if (!d.open) d.showModal();
  let r;
  try {
    r = await get("/api/nlis/check");
  } catch (e) {
    d.querySelector(".body").innerHTML = `<div class="note err">${escapeHtml(e.message)}</div>`;
    return;
  }
  const fmt = (row, k) => (k === "eid" ? eidText(row.eid) : k === "arrived" || k === "last_seen" || k === "date" ? day(row[k]) : k === "app_status" ? STATUS[row[k]] || row[k] : row[k] ?? "");
  const reports = r.reports.map((x) => `${x.direction === "off" ? "moved off" : "moved on (active)"}: ${x.n.toLocaleString("en-AU")} tags, ${day(x.from_date)} to ${day(x.to_date)}`).join("; ");
  d.innerHTML = `
    <div class="dlg wide report">
      <header><h2>NLIS check</h2><div class="muted small">${reports ? `From the NLIS reports imported: ${escapeHtml(reports)}.` : "No NLIS reports imported yet: Tools → Import an NLIS report."}</div></header>
      <div class="body">
        ${LISTS.map(([k, title, help, cols]) => `
          <h3>${escapeHtml(title)} · ${r[k].length.toLocaleString("en-AU")}</h3>
          <p class="muted small">${escapeHtml(help)}</p>
          ${r[k].length ? `<details><summary class="small">Show the list</summary>
            <table class="list"><thead><tr>${cols.map(([, t]) => `<th>${t}</th>`).join("")}</tr></thead><tbody>
              ${r[k].slice(0, 300).map((row) => `<tr>${cols.map(([c]) => `<td>${escapeHtml(String(fmt(row, c)))}</td>`).join("")}</tr>`).join("")}
            </tbody></table>${r[k].length > 300 ? `<p class="muted small">Showing 300 of ${r[k].length}; the CSV has them all.</p>` : ""}
          </details>
          <div class="btns"><button class="btn" data-csv="${k}">Export CSV</button></div>` : ""}`).join("")}
      </div>
      <footer class="btns"><button class="btn" id="nlClose">Close</button></footer>
    </div>`;
  d.querySelector("#nlClose").onclick = () => d.close();
  d.querySelectorAll("[data-csv]").forEach((b) => {
    b.onclick = () => {
      const [k, title, , cols] = LISTS.find(([x]) => x === b.dataset.csv);
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [cols.map(([, t]) => q(t)).join(","), ...r[k].map((row) => cols.map(([c]) => q(c === "eid" ? eidText(row.eid) : row[c])).join(","))];
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
      a.download = `NLIS check - ${title.replace(/[;:]/g, "")}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  });
}
