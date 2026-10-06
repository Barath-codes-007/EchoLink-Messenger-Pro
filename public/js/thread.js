(function () {
  "use strict";

  const slot = document.getElementById("thread-panel-slot");

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s || "";
    return div.innerHTML;
  }
  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  let currentRootId = null;

  async function open(rootMessageId) {
    const roomId = window.EchoApp.getActiveRoomId();
    if (!roomId) return;
    currentRootId = rootMessageId;

    slot.innerHTML = "";
    const tpl = document.getElementById("tpl-thread-panel");
    slot.appendChild(tpl.content.cloneNode(true));

    document.getElementById("thread-close").addEventListener("click", close);
    document.getElementById("thread-send").addEventListener("click", sendReply);
    document.getElementById("thread-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendReply();
    });

    await refresh();
  }

  async function refresh() {
    const roomId = window.EchoApp.getActiveRoomId();
    const body = document.getElementById("thread-panel-body");
    if (!body) return;
    body.innerHTML = `<div class="skeleton" style="height:40px;margin-bottom:8px;"></div>`;

    try {
      const ack = await EchoSocket.emitAck("thread:get", { roomId, rootMessageId: currentRootId });
      const root = window.EchoChat.getMessages().find((m) => m.id === currentRootId);

      body.innerHTML = `
        ${root ? `<div style="padding-bottom:12px; margin-bottom:12px; border-bottom:1px solid var(--border);">
          <div style="font-size:12.5px; font-weight:700; margin-bottom:3px;">${escapeHtml(root.senderName)}</div>
          <div style="font-size:13px; color:var(--text-muted);">${escapeHtml((root.content || "").slice(0, 200))}</div>
        </div>` : ""}
        ${ack.replies
          .map(
            (r) => `
          <div style="margin-bottom:12px;">
            <div style="display:flex; align-items:baseline; gap:6px; margin-bottom:3px;">
              <span style="font-size:12.5px; font-weight:700;">${escapeHtml(r.senderName)}</span>
              <span style="font-size:11px; color:var(--text-faint);">${formatTime(r.createdAt)}</span>
            </div>
            <div style="font-size:13.5px;">${escapeHtml(r.content)}</div>
          </div>`
          )
          .join("")}
      `;
    } catch (err) {
      body.innerHTML = `<p class="text-muted" style="font-size:13px;">Couldn't load thread.</p>`;
    }
  }

  async function sendReply() {
    const input = document.getElementById("thread-input");
    const content = input.value.trim();
    if (!content) return;
    const roomId = window.EchoApp.getActiveRoomId();
    try {
      await EchoSocket.emitAck("message:send", { roomId, type: "text", content, replyToId: currentRootId });
      input.value = "";
      await refresh();
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  function close() {
    slot.innerHTML = "";
    currentRootId = null;
  }

  function onNewMessage(m) {
    if (currentRootId && m.replyToId === currentRootId) refresh();
  }

  window.EchoThread = { open, close, onNewMessage, isOpen: () => !!currentRootId };
})();
