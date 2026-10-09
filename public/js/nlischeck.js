/**
 * The NLIS check: where the NLIS record for the PIC and the app disagree, as
 * lists to work through — tags NLIS still holds here that the app shows as
 * gone (record the death or transfer in NLIS), tags it holds that the app
 * doesn't know, animals here that aren't in a mob, and animals on hand here
 * that NLIS says left. Each list exports to CSV.
 */
import { get, send } from "./api.js";
import { undoable } from "./stockui.js";
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
  let r, arrivals;
  try {
    [r, arrivals] = await Promise.all([get("/api/nlis/check"), get("/api/nlis/arrivals").then((x) => x.groups)]);
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
        ${ctx.canEdit && arrivals.length ? `<h3>Deliveries with tags not in the app</h3>
          <p class="muted small">Create an animal record for each tag in a delivery and put them in their mob. Records only: head counts don't change.</p>
          <table class="list"><tbody>${arrivals.map((a, i) => `<tr>
            <td><b>${a.head}</b> tags · ${escapeHtml(a.name || a.pic || "?")} <span class="muted">${escapeHtml(a.pic || "")} · arrived ${day(a.date)}</span></td>
            <td><select data-am="${i}" aria-label="Mob"><option value="">Mob…</option><option value="none">Not in a mob yet (placed when next scanned)</option>${[...ctx.state.mobs].sort((x, y) => x.name.localeCompare(y.name)).map((m) => `<option value="${m.id}">${escapeHtml(m.name)} · ${m.head} hd</option>`).join("")}</select>
              <select data-as="${i}" aria-label="Sex"><option value="">Sex not known</option><option value="female">Heifers / cows</option><option value="steer">Steers</option><option value="male">Bulls</option></select></td>
            <td><button class="btn" data-ago="${i}">Add</button></td></tr>`).join("")}</tbody></table>` : ""}
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
  d.querySelectorAll("[data-ago]").forEach((b) => {
    b.onclick = async () => {
      const i = Number(b.dataset.ago);
      const mob = d.querySelector(`[data-am="${i}"]`).value;
      const sex = d.querySelector(`[data-as="${i}"]`).value;
      if (!mob) { ctx.toast("Choose the mob they're in", { error: true }); return; }
      b.disabled = true;
      try {
        const res = await send("POST", "/api/nlis/arrivals/add", { pic: arrivals[i].pic, date: arrivals[i].date, mob_id: mob === "none" ? "none" : Number(mob), sex: sex || null });
        undoable(ctx, res.summary, res.batch);
        openNlisCheck(ctx);
      } catch (e) {
        b.disabled = false;
        ctx.toast(e.message, { error: true });
      }
    };
  });
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
