(function () {
  "use strict";

  const root = document.getElementById("modal-root");
  const menuRoot = document.getElementById("context-menu-root");

  function openModal(templateId) {
    const tpl = document.getElementById(templateId);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.appendChild(tpl.content.cloneNode(true));
    root.appendChild(backdrop);

    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) closeModal();
    });
    document.addEventListener("keydown", escHandler);

    function escHandler(e) {
      if (e.key === "Escape") closeModal();
    }
    backdrop._escHandler = escHandler;

    return backdrop;
  }

  function closeModal() {
    const backdrop = root.firstElementChild;
    if (backdrop && backdrop._escHandler) document.removeEventListener("keydown", backdrop._escHandler);
    root.innerHTML = "";
  }

  function confirmDialog({ title, body, okLabel }) {
    return new Promise((resolve) => {
      const backdrop = openModal("tpl-confirm");
      backdrop.querySelector("#confirm-title").textContent = title || "Are you sure?";
      backdrop.querySelector("#confirm-body").textContent = body || "";
      if (okLabel) backdrop.querySelector("#confirm-ok").textContent = okLabel;
      backdrop.querySelector("#confirm-cancel").addEventListener("click", () => { closeModal(); resolve(false); });
      backdrop.querySelector("#confirm-ok").addEventListener("click", () => { closeModal(); resolve(true); });
    });
  }

  function openContextMenu(x, y, items) {
    menuRoot.innerHTML = "";
    const menu = document.createElement("div");
    menu.className = "context-menu";
    items.forEach((item) => {
      if (item === "divider") { menu.appendChild(document.createElement("hr")); return; }
      const btn = document.createElement("button");
      if (item.danger) btn.classList.add("danger");
      btn.innerHTML = item.label;
      btn.addEventListener("click", () => { closeContextMenu(); item.onClick(); });
      menu.appendChild(btn);
    });
    menuRoot.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    menu.style.left = Math.min(x, vw - rect.width - 10) + "px";
    menu.style.top = Math.min(y, vh - rect.height - 10) + "px";

    setTimeout(() => document.addEventListener("mousedown", outsideHandler), 0);
    function outsideHandler(e) {
      if (!menu.contains(e.target)) closeContextMenu();
    }
    menu._outsideHandler = outsideHandler;
  }

  function closeContextMenu() {
    const menu = menuRoot.querySelector(".context-menu");
    if (menu && menu._outsideHandler) document.removeEventListener("mousedown", menu._outsideHandler);
    menuRoot.innerHTML = "";
  }

  window.EchoModal = { open: openModal, close: closeModal, confirm: confirmDialog };
  window.EchoContextMenu = { open: openContextMenu, close: closeContextMenu };
})();
