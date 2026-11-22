/*
 * Light or dark mode, chosen with the button in the top bar and remembered on
 * this device. Loaded in <head> before the page draws, so it never flashes the
 * wrong colours. Dark is the default.
 */
(function () {
  let t = "dark";
  try { t = localStorage.getItem("grazing.theme") === "light" ? "light" : "dark"; } catch { /* private mode: dark */ }
  apply(t);

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    const meta = (name) => document.querySelector(`meta[name="${name}"]`);
    if (meta("color-scheme")) meta("color-scheme").content = theme;
    if (meta("theme-color")) meta("theme-color").content = theme === "light" ? "#FFFFFF" : "#0C1012";
  }

  window.grazingTheme = {
    get: () => document.documentElement.dataset.theme || "dark",
    set: (theme) => {
      apply(theme);
      try { localStorage.setItem("grazing.theme", theme); } catch { /* not remembered */ }
    },
  };
})();
