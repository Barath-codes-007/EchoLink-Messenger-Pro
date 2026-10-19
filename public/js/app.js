(function () {
  "use strict";

  let me = null;
  let activeRoom = null;
  let activeRoomMembers = [];

  /* ============================== Bootstrap ============================== */

  async function bootstrap() {
    try {
      const { user } = await EchoAPI.get("/api/auth/me");
      me = user;
    } catch (err) {
      window.location.href = "/auth.html?mode=login";
      return;
    }

    applyMe();
    EchoTheme.set(me.theme || EchoTheme.get());

    EchoSocket.connect();
    EchoCall.init();
    EchoGroupCall.init();
    bindSocketEvents();

    await EchoRooms.load();
    ensureNotifPermission();

    const params = new URLSearchParams(location.search);
    if (params.get("join")) EchoRooms.openJoinModal(params.get("join"));
    if (params.get("demo")) EchoToast.info("Demo mode — sign up to save your rooms permanently.");
  }

  function applyMe() {
    document.getElementById("my-username").textContent = me.username;
    document.getElementById("my-status-label").textContent = me.status;
    document.getElementById("my-status-dot").className = `status-dot status-${me.status}`;
    document.getElementById("my-avatar").src = me.avatarUrl || avatarPlaceholder(me.username);
  }

  function avatarPlaceholder(name) {
    const initials = (name || "?").slice(0, 2).toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#6C5CE7"/><text x="50%" y="54%" font-family="Inter,sans-serif" font-size="24" fill="white" text-anchor="middle" dominant-baseline="middle">${initials}</text></svg>`;
    return "data:image/svg+xml;base64," + btoa(svg);
  }

  /* ============================== Socket events ============================== */

  function bindSocketEvents() {
    // A reconnect gets a new socket.id server-side, so the room the socket
    // was joined to and this user's live presence status need to be
    // re-established explicitly — otherwise a reconnected user stops
    // receiving events for their open room until they switch rooms or reload.
    EchoSocket.onReconnect(async () => {
      if (activeRoom) {
        try {
          const ack = await EchoSocket.emitAck("room:join", { roomId: activeRoom.id });
          activeRoom = { ...activeRoom, ...ack.room };
          refreshHeader(activeRoom);
          const { members } = await EchoAPI.get(`/api/rooms/${activeRoom.id}/members`);
          activeRoomMembers = members;
          EchoChat.setMemberLastReadMap(members);
        } catch (e) {
          // Room may have been deleted, or membership revoked, while offline.
          closeRoom();
        }
      }
      // The server marks this user offline on disconnect — restore whatever
      // status they'd actually chosen rather than leaving it stuck there.
      if (me?.status) EchoSocket.emit("presence:status", { status: me.status });
    });

    EchoSocket.on("message:new", (m) => {
      EchoChat.onMessageNew(m);
      window.EchoThread?.onNewMessage(m);
      const room = EchoRooms.getAll().find((r) => r.id === m.roomId) || activeRoom;
      maybeNotify(m, room);
    });
    EchoSocket.on("message:edited", (p) => EchoChat.onMessageEdited(p));
    EchoSocket.on("message:deleted", (p) => EchoChat.onMessageDeleted(p));
    EchoSocket.on("message:pinned", (p) => EchoChat.onMessagePinned(p));
    EchoSocket.on("message:reaction", (p) => EchoChat.onReaction(p));
    EchoSocket.on("message:seen", (p) => EchoChat.onSeen(p));
    EchoSocket.on("typing", (p) => EchoChat.onTyping(p));
    EchoSocket.on("voice:recording", (p) => EchoChat.onVoiceRecording(p));
    EchoSocket.on("poll:updated", (p) => EchoChat.onPollUpdated(p));
    EchoSocket.on("poll:closed", (p) => EchoChat.onPollClosed(p));
    EchoSocket.on("location:updated", (p) => EchoChat.onLocationUpdated(p));
    EchoSocket.on("location:stopped", (p) => EchoChat.onLocationStopped(p));

    EchoSocket.on("room:join-request", ({ roomId, roomName, username }) => {
      EchoToast.info(`${username} wants to join "${roomName}" — approve in Room Settings.`);
    });
    EchoSocket.on("room:join-approved", ({ roomId }) => {
      EchoToast.success("Your request to join was approved!");
      EchoRooms.load();
    });
    EchoSocket.on("room:join-rejected", () => {
      EchoToast.error("Your request to join was declined.");
    });

    EchoSocket.on("presence:update", ({ roomId, onlineCount }) => {
      if (activeRoom && roomId === activeRoom.id) {
        document.getElementById("header-room-sub").textContent = `${activeRoomMembers.length || activeRoom.memberCount} members · ${onlineCount} online`;
      }
    });
    EchoSocket.on("presence:user-joined", ({ username }) => {
      if (activeRoom) EchoToast.info(`${username} joined the room`);
    });
    EchoSocket.on("presence:user-left", ({ username }) => {
      if (activeRoom) EchoToast.info(`${username} left the room`);
    });
    EchoSocket.on("room:deleted", ({ roomId, reason }) => {
      EchoRooms.remove(roomId);
      if (activeRoom && activeRoom.id === roomId) {
        closeRoom();
        const why = reason === "expired" ? "This room's time limit was reached and it was deleted." : "This room was deleted because its creator logged out.";
        EchoToast.info(why);
      }
    });
    EchoSocket.on("presence:status-changed", ({ userId, status }) => {
      const dot = document.querySelector(`.member-row[data-user-id="${userId}"] .status-dot`);
      if (dot) dot.className = `status-dot status-${status}`;
    });
  }

  /* ============================== Starred / call history / blocked ============================== */

  function formatWhen(ts) {
    return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  async function openStarredModal() {
    EchoModal.close();
    const backdrop = EchoModal.open("tpl-starred");
    const list = backdrop.querySelector("#starred-list");
    list.innerHTML = `<div class="skeleton" style="height:50px;"></div>`;
    try {
      const { starred } = await EchoAPI.get("/api/users/me/starred");
      if (starred.length === 0) {
        list.innerHTML = `<p class="text-muted" style="font-size:13px;">No starred messages yet.</p>`;
        return;
      }
      list.innerHTML = starred
        .map(
          (s) => `
        <div class="room-item" data-room-id="${s.roomId}" data-msg-id="${s.id}" style="cursor:pointer;">
          <div class="room-icon" style="width:34px;height:34px;font-size:12px;">${escapeHtml(s.roomName.slice(0, 2).toUpperCase())}</div>
          <div class="room-meta">
            <div class="room-name" style="font-size:13px;">${escapeHtml(s.senderName)} in ${escapeHtml(s.roomName)}</div>
            <div class="room-sub">${escapeHtml((s.content || s.fileName || s.type).slice(0, 70))} · ${formatWhen(s.createdAt)}</div>
          </div>
        </div>`
        )
        .join("");
      list.querySelectorAll("[data-room-id]").forEach((el) => {
        el.addEventListener("click", async () => {
          EchoModal.close();
          await openRoom(el.dataset.roomId);
        });
      });
    } catch (err) {
      list.innerHTML = `<p class="text-muted" style="font-size:13px;">Couldn't load starred messages.</p>`;
    }
  }

  async function openCallHistoryModal() {
    EchoModal.close();
    const backdrop = EchoModal.open("tpl-call-history");
    const list = backdrop.querySelector("#call-history-list");
    list.innerHTML = `<div class="skeleton" style="height:50px;"></div>`;
    try {
      const { calls } = await EchoAPI.get("/api/users/me/calls");
      if (calls.length === 0) {
        list.innerHTML = `<p class="text-muted" style="font-size:13px;">No calls yet.</p>`;
        return;
      }
      const statusIcon = { completed: "✅", missed: "📵", declined: "🚫" };
      const dirIcon = { incoming: "↙", outgoing: "↗" };
      list.innerHTML = calls
        .map(
          (c) => `
        <div class="room-item" style="cursor:default;">
          <div class="room-icon" style="width:34px;height:34px;font-size:14px;">${c.callType === "video" ? "🎥" : "📞"}</div>
          <div class="room-meta">
            <div class="room-name" style="font-size:13px;">${dirIcon[c.direction]} ${escapeHtml(c.peerName || "Unknown")} <span class="text-muted">in ${escapeHtml(c.roomName || "a room")}</span></div>
            <div class="room-sub">${statusIcon[c.status] || ""} ${c.status} · ${c.durationSec ? Math.floor(c.durationSec / 60) + "m " + (c.durationSec % 60) + "s" : "0s"} · ${formatWhen(c.startedAt)}</div>
          </div>
        </div>`
        )
        .join("");
    } catch (err) {
      list.innerHTML = `<p class="text-muted" style="font-size:13px;">Couldn't load call history.</p>`;
    }
  }

  async function openBlockedModal() {
    EchoModal.close();
    const backdrop = EchoModal.open("tpl-blocked");
    const list = backdrop.querySelector("#blocked-list");
    list.innerHTML = `<div class="skeleton" style="height:50px;"></div>`;
    try {
      const { blocked } = await EchoAPI.get("/api/users/me/blocked");
      if (blocked.length === 0) {
        list.innerHTML = `<p class="text-muted" style="font-size:13px;">You haven't blocked anyone.</p>`;
        return;
      }
      list.innerHTML = blocked
        .map(
          (u) => `
        <div class="room-item" data-user-id="${u.id}">
          <div class="avatar-fallback" style="width:34px;height:34px;font-size:12px;">${escapeHtml(u.username.slice(0, 2).toUpperCase())}</div>
          <div class="room-meta"><div class="room-name" style="font-size:13px;">${escapeHtml(u.username)}</div></div>
          <button class="btn btn-secondary" style="padding:6px 12px; font-size:12px;" data-unblock="${u.id}">Unblock</button>
        </div>`
        )
        .join("");
      list.querySelectorAll("[data-unblock]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await EchoAPI.del(`/api/users/${btn.dataset.unblock}/block`);
          EchoToast.success("Unblocked.");
          openBlockedModal();
        });
      });
    } catch (err) {
      list.innerHTML = `<p class="text-muted" style="font-size:13px;">Couldn't load blocked users.</p>`;
    }
  }

  /* ============================== Browser notifications ============================== */

  let notifPermissionAsked = false;

  async function ensureNotifPermission() {
    if (!("Notification" in window) || notifPermissionAsked) return;
    notifPermissionAsked = true;
    if (Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
  }

  function maybeNotify(message, room) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden) return; // only notify when the tab isn't focused
    if (message.senderId === me.id) return;
    const isMentioned = message.mentions?.includes(me.username);
    if (room?.mutedByMe && !isMentioned) return;

    const body = message.type === "text" ? message.content : `Sent ${message.type === "image" ? "a photo" : message.type === "audio" ? "a voice note" : "a file"}`;
    try {
      const n = new Notification(`${message.senderName} · ${room?.name || "EchoLink"}`, {
        body: body.slice(0, 120),
        icon: "/favicon.ico",
        tag: "echolink-" + message.roomId,
      });
      n.onclick = () => { window.focus(); openRoom(message.roomId); n.close(); };
    } catch (e) { /* Notification constructor can throw in some contexts — non-critical */ }
  }

  /* ============================== Room switching ============================== */

  async function openRoom(roomId) {
    const roomList = EchoRooms.getAll();
    const roomMeta = roomList.find((r) => r.id === roomId);
    if (!roomMeta) return;

    // Leave the previously active room's Socket.IO room first — otherwise
    // switching Room A -> Room B -> Room C leaves the socket still joined
    // to A and B, so their events (messages, typing, presence) keep
    // arriving and piling up indefinitely as more rooms are visited.
    if (activeRoom && activeRoom.id !== roomId) {
      EchoSocket.emit("room:leave", { roomId: activeRoom.id });
    }

    try {
      const ack = await EchoSocket.emitAck("room:join", { roomId });
      activeRoom = ack.room;
    } catch (err) {
      EchoToast.error(err.message);
      return;
    }

    EchoRooms.setActive(roomId);
    document.getElementById("empty-state").classList.add("hidden");
    document.getElementById("room-view").classList.remove("hidden");
    document.getElementById("sidebar").classList.add("hidden-mobile");
    document.getElementById("chat-main").classList.remove("hidden-mobile");

    refreshHeader(activeRoom);
    EchoChat.setContext(me, activeRoom);
    await EchoChat.loadInitialMessages();

    try {
      const { members } = await EchoAPI.get(`/api/rooms/${roomId}/members`);
      activeRoomMembers = members;
      EchoChat.setMemberLastReadMap(members);
    } catch (e) { activeRoomMembers = []; }

    document.querySelector('.details-tab[data-tab="members"]').click();
  }

  function closeRoom() {
    if (activeRoom) EchoSocket.emit("room:leave", { roomId: activeRoom.id });
    activeRoom = null;
    document.getElementById("empty-state").classList.remove("hidden");
    document.getElementById("room-view").classList.add("hidden");
    document.getElementById("sidebar").classList.remove("hidden-mobile");
  }

  function refreshHeader(room) {
    activeRoom = { ...activeRoom, ...room };
    document.getElementById("header-room-icon").textContent = room.type === "temporary" ? "⏱" : room.name.slice(0, 2).toUpperCase();
    document.getElementById("header-room-name").textContent = room.name;
    document.getElementById("header-room-sub").textContent = `${room.memberCount} member${room.memberCount === 1 ? "" : "s"} · ${room.type}`;
  }

  document.getElementById("btn-mobile-back").addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("hidden-mobile");
    document.getElementById("chat-main").classList.add("hidden-mobile");
  });

  document.getElementById("btn-toggle-members").addEventListener("click", () => {
    document.getElementById("details-panel").classList.toggle("hidden");
  });

  document.getElementById("btn-room-settings").addEventListener("click", () => {
    if (activeRoom) EchoRooms.openRoomSettings(activeRoom, activeRoom.myRole);
  });

  /* ============================== Calling ============================== */

  function startCall(callType) {
    if (!activeRoom) return;
    const others = activeRoomMembers.filter((m) => m.id !== me.id);
    if (others.length === 0) return EchoToast.error("No one else is in this room yet.");

    if (others.length === 1) {
      return EchoCall.start(activeRoom.id, others[0], callType);
    }

    const btn = document.getElementById(callType === "video" ? "btn-call-video" : "btn-call-voice");
    const rect = btn.getBoundingClientRect();
    const items = [
      { label: `👥 Start group ${callType} call (entire room)`, onClick: () => EchoGroupCall.start(activeRoom.id, callType) },
      { label: `☑️ Start group ${callType} call (choose members)`, onClick: () => EchoGroupCall.openMemberPicker(activeRoom.id, callType, others) },
      "divider",
      ...others.map((m) => ({ label: `📞 Call ${m.username} only`, onClick: () => EchoCall.start(activeRoom.id, m, callType) })),
    ];
    EchoContextMenu.open(rect.left, rect.bottom + 8, items);
  }

  document.getElementById("btn-call-voice").addEventListener("click", () => startCall("voice"));
  document.getElementById("btn-call-video").addEventListener("click", () => startCall("video"));

  /* ============================== Theme & status ============================== */

  document.getElementById("theme-toggle").addEventListener("click", () => EchoTheme.toggle());

  (function initSidebarCollapse() {
    const appShell = document.getElementById("app-shell");
    const collapseBtn = document.getElementById("sidebar-collapse-btn");
    const expandBtn = document.getElementById("sidebar-expand-btn");

    function setCollapsed(collapsed) {
      appShell.classList.toggle("sidebar-collapsed", collapsed);
      collapseBtn.setAttribute("aria-expanded", String(!collapsed));
      localStorage.setItem("echolink:sidebarCollapsed", collapsed ? "1" : "0");
    }

    if (localStorage.getItem("echolink:sidebarCollapsed") === "1") setCollapsed(true);

    collapseBtn.addEventListener("click", () => setCollapsed(true));
    expandBtn.addEventListener("click", () => setCollapsed(false));
    EchoCallFx?.enhanceButtons(document.body, "#sidebar-collapse-btn, #sidebar-expand-btn");
  })();

  document.getElementById("my-avatar-wrap").addEventListener("click", (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    EchoContextMenu.open(rect.right, rect.top, [
      { label: "🟢 Online", onClick: () => setStatus("online") },
      { label: "🌙 Away", onClick: () => setStatus("away") },
      { label: "⛔ Do Not Disturb", onClick: () => setStatus("dnd") },
      { label: "👻 Invisible", onClick: () => setStatus("invisible") },
    ]);
  });

  async function setStatus(status) {
    EchoSocket.emit("presence:status", { status });
    try {
      await EchoAPI.patch("/api/users/me", { status });
      me.status = status;
      applyMe();
    } catch (err) { /* non-critical */ }
  }

  /* ============================== Profile settings ============================== */

  document.getElementById("btn-settings").addEventListener("click", openProfileSettings);

  function openProfileSettings() {
    const backdrop = EchoModal.open("tpl-profile-settings");
    backdrop.querySelector("#ps-avatar").src = me.avatarUrl || avatarPlaceholder(me.username);
    backdrop.querySelector("#ps-bio").value = me.bio || "";
    backdrop.querySelector("#ps-status").value = me.status;
    backdrop.querySelector("#ps-theme").value = EchoTheme.get();

    const fileInput = backdrop.querySelector("#ps-avatar-input");
    backdrop.querySelector("#ps-upload-avatar").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append("avatar", file);
      try {
        const { avatarUrl } = await EchoAPI.postForm("/api/users/me/avatar", fd);
        me.avatarUrl = avatarUrl;
        backdrop.querySelector("#ps-avatar").src = avatarUrl;
        applyMe();
        EchoToast.success("Photo updated.");
      } catch (err) {
        EchoToast.error(err.message);
      }
    });

    backdrop.querySelector("#ps-save").addEventListener("click", async () => {
      try {
        const theme = backdrop.querySelector("#ps-theme").value;
        const { user } = await EchoAPI.patch("/api/users/me", {
          bio: backdrop.querySelector("#ps-bio").value,
          status: backdrop.querySelector("#ps-status").value,
          theme,
        });
        me = user;
        EchoTheme.set(theme);
        applyMe();
        EchoToast.success("Profile saved.");
        EchoModal.close();
      } catch (err) {
        EchoToast.error(err.message);
      }
    });

    backdrop.querySelector("#ps-change-password").addEventListener("click", () => {
      const pwBackdrop = EchoModal.open("tpl-change-password");
      pwBackdrop.querySelector("#cp-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await EchoAPI.post("/api/users/me/change-password", {
            currentPassword: pwBackdrop.querySelector("#cp-current").value,
            newPassword: pwBackdrop.querySelector("#cp-new").value,
          });
          EchoToast.success("Password changed.");
          EchoModal.close();
        } catch (err) {
          EchoToast.error(err.message);
        }
      });
    });

    backdrop.querySelector("#ps-export").addEventListener("click", () => {
      window.open("/api/users/me/export", "_blank");
    });

    backdrop.querySelector("#ps-starred").addEventListener("click", openStarredModal);
    backdrop.querySelector("#ps-call-history").addEventListener("click", openCallHistoryModal);
    backdrop.querySelector("#ps-blocked").addEventListener("click", openBlockedModal);

    backdrop.querySelector("#ps-logout").addEventListener("click", async () => {
      await EchoAPI.post("/api/auth/logout");
      window.location.href = "/";
    });

    backdrop.querySelector("#ps-delete-account").addEventListener("click", async () => {
      const ok = await EchoModal.confirm({ title: "Delete your account?", body: "This permanently deletes your profile and cannot be undone.", okLabel: "Delete account" });
      if (!ok) return;
      try {
        await EchoAPI.del("/api/users/me");
        window.location.href = "/";
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  /* ============================== Public API for other modules ============================== */

  window.EchoApp = {
    openRoom,
    closeRoom,
    refreshHeader,
    getActiveRoomId: () => activeRoom?.id || null,
    getActiveRoom: () => activeRoom,
    getActiveRoomMembers: () => activeRoomMembers,
    getMyRole: () => activeRoom?.myRole || "member",
    getMe: () => me,
  };

  bootstrap();
})();
