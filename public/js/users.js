/**
 * Users and passwords: administrators add people, reset their passwords,
 * switch them between administrator and view-only, or remove them; anyone
 * can change their own password. The server keeps at least one
 * administrator and won't let you delete the account you're signed in with.
 */
import { get, send } from "./api.js";
import { escapeHtml } from "./map.js";

const when = (ms) => (ms ? new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
const ROLE = { admin: "Administrator", viewer: "View only" };

export async function openUsers(ctx) {
  const d = ctx.dialog;
  const me = ctx.state.meta?.user || null;
  let users = [];
  if (ctx.canEdit) {
    try { users = await get("/api/auth/users"); } catch (e) { ctx.toast(e.message, { error: true }); }
  }
  d.innerHTML = `
    <div class="dlg">
      <header><h2>Users and passwords</h2></header>
      <div class="body">
        ${ctx.canEdit ? `
        <table class="list"><thead><tr><th>User</th><th>Access</th><th>Last signed in</th><th></th></tr></thead><tbody>
          ${users.map((u) => `<tr>
            <td><b>${escapeHtml(u.username)}</b>${me && me.username === u.username ? ' <span class="muted tiny">(you)</span>' : ""}</td>
            <td><select data-role="${u.id}" aria-label="Access for ${escapeHtml(u.username)}">
              ${Object.entries(ROLE).map(([k, t]) => `<option value="${k}"${u.role === k ? " selected" : ""}>${t}</option>`).join("")}</select></td>
            <td class="small">${escapeHtml(when(u.lastLogin))}</td>
            <td class="num"><button class="linkbtn" data-reset="${u.id}">New password</button>
              ${me && me.username === u.username ? "" : ` · <button class="linkbtn danger-link" data-del="${u.id}">Remove</button>`}</td>
          </tr>`).join("")}
        </tbody></table>

        <h3>Add a user</h3>
        <div class="row2">
          <div class="f"><label for="nuName">Username</label><input id="nuName" autocomplete="off" placeholder="e.g. tom"></div>
          <div class="f"><label for="nuRole">Access</label><select id="nuRole"><option value="viewer">View only</option><option value="admin">Administrator</option></select></div>
        </div>
        <div class="f"><label for="nuPass">Password</label><input id="nuPass" type="text" autocomplete="new-password" placeholder="at least 8 characters"></div>
        <div class="btns"><button class="btn primary" id="nuAdd">Add user</button></div>
        <p class="muted tiny"><b>View only</b> can see everything but record nothing. <b>Administrators</b> can record moves, weights, imports and change settings, including these users. Give the person their username and password yourself; they can change the password after signing in.</p>
        ` : ""}

        <h3>Change my password</h3>
        <div class="f"><label for="cpOld">Current password</label><input id="cpOld" type="password" autocomplete="current-password"></div>
        <div class="f"><label for="cpNew">New password</label><input id="cpNew" type="password" autocomplete="new-password" placeholder="at least 8 characters"></div>
        <div class="btns"><button class="btn" id="cpGo">Change password</button></div>
      </div>
      <footer class="btns"><button class="btn" id="usClose">Close</button></footer>
    </div>`;
  if (!d.open) d.showModal();
  const again = () => openUsers(ctx);
  const run = async (fn, ok) => {
    try { await fn(); ctx.toast(ok); again(); } catch (e) { ctx.toast(e.message, { error: true }); }
  };
  d.querySelector("#usClose").onclick = () => d.close();
  d.querySelector("#cpGo").onclick = async () => {
    try {
      await send("POST", "/api/auth/change-password", { currentPassword: d.querySelector("#cpOld").value, newPassword: d.querySelector("#cpNew").value });
      ctx.toast("Password changed");
      d.querySelector("#cpOld").value = d.querySelector("#cpNew").value = "";
    } catch (e) { ctx.toast(e.message, { error: true }); }
  };
  if (!ctx.canEdit) return;
  d.querySelector("#nuAdd").onclick = () => run(() => send("POST", "/api/auth/users", {
    username: d.querySelector("#nuName").value.trim(), password: d.querySelector("#nuPass").value, role: d.querySelector("#nuRole").value,
  }), "User added");
  d.querySelectorAll("[data-role]").forEach((s) => {
    s.onchange = () => run(() => send("POST", `/api/auth/users/${s.dataset.role}/role`, { role: s.value }), "Access changed");
  });
  d.querySelectorAll("[data-reset]").forEach((b) => {
    b.onclick = () => {
      const u = users.find((x) => String(x.id) === b.dataset.reset);
      const pw = prompt(`New password for ${u.username} (at least 8 characters). Their other sign-ins are ended.`);
      if (pw) run(() => send("POST", `/api/auth/users/${u.id}/password`, { password: pw }), `Password for ${u.username} changed`);
    };
  });
  d.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => {
      const u = users.find((x) => String(x.id) === b.dataset.del);
      if (confirm(`Remove ${u.username}? They're signed out at once.`)) run(() => send("DELETE", `/api/auth/users/${u.id}`), `${u.username} removed`);
    };
  });
}
