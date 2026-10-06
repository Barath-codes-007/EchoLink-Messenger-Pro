(function () {
  "use strict";
  var stored = null;
  try { stored = window.__echolinkUser && window.__echolinkUser.theme; } catch (e) {}
  var saved = stored || localStorage.getItem("echolink:theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);

  window.EchoTheme = {
    get: function () {
      return document.documentElement.getAttribute("data-theme") || "dark";
    },
    set: function (theme) {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("echolink:theme", theme);
      document.dispatchEvent(new CustomEvent("echolink:theme-changed", { detail: { theme: theme } }));
    },
    toggle: function () {
      var next = this.get() === "dark" ? "light" : "dark";
      this.set(next);
      return next;
    },
  };
})();
