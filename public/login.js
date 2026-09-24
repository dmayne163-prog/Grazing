/*
 * Sign-in page behaviour.
 *
 * Lifted out of an inline <script> so the Content-Security-Policy can forbid
 * inline script entirely — the single most valuable thing a CSP does, and
 * worth more on this page than on any other, because this is the one a
 * stranger can reach.
 */
(function () {
  var form = document.getElementById("form");
  var msg = document.getElementById("msg");
  var submit = document.getElementById("submit");
  var pwd = document.getElementById("password");
  var setup = false;

  function say(text, kind) {
    msg.textContent = text;
    msg.className = "msg" + (kind ? " " + kind : "");
  }

  // Ask the server whether this is a first run, so the same page can serve as
  // both the sign-in screen and the one-time setup screen.
  fetch("/api/auth/me")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.user) { location.href = "/"; return; }
      if (!d.setupRequired) return;

      // Setup is only offered to callers the server will actually accept it
      // from. Showing the form to someone on the internet, then refusing them,
      // would just tell an attacker that an unclaimed install is sitting here.
      if (d.setupAllowed === false) {
        document.getElementById("heading").textContent = "Setup not available here";
        document.getElementById("sub").textContent =
          "No account exists yet. For safety the first administrator can only be " +
          "created from the local network — open the app on the property, " +
          "or use the setup token.";
        form.querySelectorAll(".f, .submit").forEach(function (el) { el.hidden = true; });
        return;
      }

      setup = true;
      document.getElementById("heading").textContent = "Create administrator";
      document.getElementById("sub").textContent =
        "First run — choose the account you will manage the farm records with.";
      document.getElementById("setupNote").hidden = false;
      submit.textContent = "Create account";
      pwd.setAttribute("autocomplete", "new-password");
    })
    .catch(function () { say("Cannot reach the server.", "err"); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("username").value.trim();
    var password = pwd.value;
    if (!username || !password) { say("Enter a username and password.", "err"); return; }

    submit.disabled = true;
    say(setup ? "Creating account…" : "Signing in…");

    fetch(setup ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(function (r) {
        return r.json().then(function (b) {
          return { ok: r.ok, status: r.status, body: b };
        });
      })
      .then(function (res) {
        if (res.status === 429) {
          // Locked out. Say how long, and keep the button disabled for it, so
          // the honest case of a forgotten password does not turn into more
          // failed attempts that extend the lockout.
          var secs = Number(res.body.retryAfterSeconds) || 60;
          say("Too many failed attempts. Try again in " + describe(secs) + ".", "err");
          countdown(secs);
          return;
        }
        if (!res.ok) {
          say(res.body.error || "Sign in failed.", "err");
          submit.disabled = false;
          return;
        }
        say("Signed in — loading the map…", "ok");
        location.href = "/";
      })
      .catch(function () { say("Cannot reach the server.", "err"); submit.disabled = false; });
  });

  function describe(secs) {
    if (secs < 90) return Math.max(1, Math.round(secs)) + " seconds";
    return Math.round(secs / 60) + " minutes";
  }

  function countdown(secs) {
    var left = secs;
    var tick = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        submit.disabled = false;
        say("You can try again now.");
        return;
      }
      say("Too many failed attempts. Try again in " + describe(left) + ".", "err");
    }, 1000);
  }
})();
