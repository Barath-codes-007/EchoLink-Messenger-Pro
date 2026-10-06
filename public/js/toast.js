(function () {
  "use strict";

  function ensureStack() {
    var stack = document.getElementById("toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "toast-stack";
      document.body.appendChild(stack);
    }
    return stack;
  }

  function toast(message, type) {
    type = type || "info";
    var stack = ensureStack();
    var el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(function () {
      el.classList.add("leaving");
      setTimeout(function () { el.remove(); }, 260);
    }, 3600);
  }

  window.EchoToast = {
    info: function (m) { toast(m, "info"); },
    success: function (m) { toast(m, "success"); },
    error: function (m) { toast(m, "error"); },
  };
})();
