(function () {
  "use strict";

  const roomListEl = document.getElementById("room-list");
  let rooms = [];
  let activeRoomId = null;

  function initials(name) {
    return (name || "?").trim().slice(0, 2).toUpperCase();
  }

  function timeAgo(unixSec) {
    if (!unixSec) return "";
    const diff = Date.now() / 1000 - unixSec;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  async function loadRooms() {
    try {
      const { rooms: list } = await EchoAPI.get("/api/rooms");
      rooms = list;
      renderRoomList();
    } catch (err) {
      EchoToast.error("Couldn't load your rooms.");
    }
  }

  function renderRoomList(filter) {
    const q = (filter || "").toLowerCase();
    const visible = rooms.filter((r) => !q || r.name.toLowerCase().includes(q));

    if (rooms.length === 0) {
      roomListEl.innerHTML = `<div style="padding:20px 10px; text-align:center;"><p class="text-muted" style="font-size:13px;">No rooms yet. Create or join one to get started.</p></div>`;
      return;
    }
    if (visible.length === 0) {
      roomListEl.innerHTML = `<div style="padding:20px 10px; text-align:center;"><p class="text-muted" style="font-size:13px;">No rooms match "${filter}".</p></div>`;
      return;
    }

    roomListEl.innerHTML = visible
      .map(
        (r) => `
      <div class="room-item ${r.id === activeRoomId ? "active" : ""}" data-room-id="${r.id}">
        <div class="room-icon ${r.type === "temporary" ? "temp" : ""}">${r.type === "temporary" ? "⏱" : initials(r.name)}</div>
        <div class="room-meta">
          <div class="room-name">${escapeHtml(r.name)}</div>
          <div class="room-sub">${r.memberCount} member${r.memberCount === 1 ? "" : "s"} · ${r.code}${r.type === "temporary" ? " · temp" : ""}</div>
        </div>
      </div>`
      )
      .join("");

    roomListEl.querySelectorAll(".room-item").forEach((el) => {
      el.addEventListener("click", () => window.EchoApp.openRoom(el.dataset.roomId));
    });
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s || "";
    return div.innerHTML;
  }

  function setActiveRoom(id) {
    activeRoomId = id;
    renderRoomList(document.getElementById("room-search").value);
  }

  function upsertRoom(room) {
    const idx = rooms.findIndex((r) => r.id === room.id);
    if (idx >= 0) rooms[idx] = { ...rooms[idx], ...room };
    else rooms.unshift(room);
    renderRoomList(document.getElementById("room-search").value);
  }

  function removeRoom(id) {
    rooms = rooms.filter((r) => r.id !== id);
    renderRoomList();
  }

  document.getElementById("room-search").addEventListener("input", (e) => renderRoomList(e.target.value));

  /* ============================== QR code ============================== */

  function openQRModal(code) {
    const backdrop = EchoModal.open("tpl-qr");
    backdrop.querySelector("#qr-code-text").textContent = code;
    const slot = backdrop.querySelector("#qr-canvas-slot");
    const joinUrl = `${window.location.origin}/app.html?join=${code}`;
    if (window.QRCode) {
      new QRCode(slot, { text: joinUrl, width: 200, height: 200, colorDark: "#000000", colorLight: "#ffffff" });
    } else {
      slot.innerHTML = `<p class="text-muted" style="font-size:13px;">QR code library failed to load — use the invite link instead.</p>`;
    }
  }

  /* ============================== Create room modal ============================== */

  const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  function randomCodePreview(length = 6) {
    let out = "";
    for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return out;
  }

  document.getElementById("btn-create-room").addEventListener("click", () => {
    const backdrop = EchoModal.open("tpl-create-room");
    const codeInput = backdrop.querySelector("#cr-code");
    const expiryField = backdrop.querySelector("#cr-expiry-field");
    const expiryInputs = backdrop.querySelector("#cr-expiry-inputs");

    backdrop.querySelector("#cr-generate-code").addEventListener("click", () => {
      codeInput.value = randomCodePreview();
    });
    backdrop.querySelector("#cr-preview-qr").addEventListener("click", () => {
      const code = codeInput.value.trim() || randomCodePreview();
      codeInput.value = code;
      openQRModal(code);
      EchoToast.info("Preview only — this QR works once the room is created.");
    });

    function syncTypeUI() {
      const type = backdrop.querySelector('input[name="cr-type"]:checked').value;
      expiryField.style.display = type === "temporary" ? "block" : "none";
    }
    backdrop.querySelectorAll('input[name="cr-type"]').forEach((r) => r.addEventListener("change", syncTypeUI));
    syncTypeUI();

    backdrop.querySelector("#cr-expire-time").addEventListener("change", (e) => {
      expiryInputs.style.display = e.target.checked ? "flex" : "none";
    });

    backdrop.querySelector("#create-room-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = backdrop.querySelector("#cr-name").value.trim();
      const description = backdrop.querySelector("#cr-desc").value.trim();
      const type = backdrop.querySelector('input[name="cr-type"]:checked').value;
      const password = backdrop.querySelector("#cr-password").value;
      const customCode = codeInput.value.trim();

      let expiresInSeconds = null;
      let deleteOnOwnerLogout = false;
      if (type === "temporary") {
        if (backdrop.querySelector("#cr-expire-time").checked) {
          const h = parseInt(backdrop.querySelector("#cr-expire-h").value, 10) || 0;
          const m = parseInt(backdrop.querySelector("#cr-expire-m").value, 10) || 0;
          const s = parseInt(backdrop.querySelector("#cr-expire-s").value, 10) || 0;
          expiresInSeconds = h * 3600 + m * 60 + s;
          if (expiresInSeconds <= 0) {
            EchoToast.error("Enter a duration greater than zero, or uncheck the time option.");
            return;
          }
        }
        deleteOnOwnerLogout = backdrop.querySelector("#cr-expire-logout").checked;
      }

      try {
        const { room } = await EchoAPI.post("/api/rooms", {
          name,
          description,
          type,
          password: password || undefined,
          code: customCode || undefined,
          expiresInSeconds,
          deleteOnOwnerLogout,
        });
        upsertRoom(room);
        EchoModal.close();
        showRoomCreated(room);
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  });

  function showRoomCreated(room) {
    const backdrop = EchoModal.open("tpl-room-created");
    backdrop.querySelector("#rc-code").textContent = room.code;
    backdrop.querySelector("#rc-qr").addEventListener("click", () => openQRModal(room.code));
    backdrop.querySelector("#rc-copy").addEventListener("click", () => {
      const link = `${window.location.origin}/app.html?join=${room.code}`;
      navigator.clipboard.writeText(link).then(() => EchoToast.success("Invite link copied!"));
    });
    backdrop.querySelector("#rc-enter").addEventListener("click", () => {
      EchoModal.close();
      window.EchoApp.openRoom(room.id);
    });
  }

  /* ============================== Join room modal ============================== */

  document.getElementById("btn-join-room").addEventListener("click", () => openJoinModal());

  function openJoinModal(prefillCode) {
    const backdrop = EchoModal.open("tpl-join-room");
    if (prefillCode) backdrop.querySelector("#jr-code").value = prefillCode;
    backdrop.querySelector("#join-room-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = backdrop.querySelector("#jr-code").value.trim();
      const password = backdrop.querySelector("#jr-password").value;
      try {
        const result = await EchoAPI.post("/api/rooms/join", { code, password: password || undefined });
        EchoModal.close();
        if (result.pending) {
          EchoToast.info(result.message || "Your join request is pending approval.");
          return;
        }
        upsertRoom(result.room);
        EchoToast.success(`Joined ${result.room.name}!`);
        window.EchoApp.openRoom(result.room.id);
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  /* ============================== Room settings modal ============================== */

  function openRoomSettings(room, myRole) {
    const backdrop = EchoModal.open("tpl-room-settings");
    backdrop.querySelector("#rs-code-line").textContent = `Room code: ${room.code}`;
    backdrop.querySelector("#rs-name").value = room.name;
    backdrop.querySelector("#rs-desc").value = room.description || "";

    const cached = rooms.find((r) => r.id === room.id);
    backdrop.querySelector("#rs-mute").checked = !!(cached && cached.mutedByMe);
    backdrop.querySelector("#rs-require-approval").checked = !!room.requireApproval;

    backdrop.querySelector("#rs-qr").classList.remove("hidden");
    backdrop.querySelector("#rs-qr").addEventListener("click", () => openQRModal(room.code));

    const canEdit = ["owner", "admin"].includes(myRole);
    ["rs-name", "rs-desc", "rs-password"].forEach((id) => (backdrop.querySelector("#" + id).disabled = !canEdit));
    backdrop.querySelector("#rs-delete").classList.toggle("hidden", myRole !== "owner");

    if (canEdit) {
      backdrop.querySelector("#rs-view-pending").classList.remove("hidden");
      backdrop.querySelector("#rs-view-pending").addEventListener("click", () => openPendingRequestsModal(room.id));
    } else {
      backdrop.querySelector("#rs-require-approval").disabled = true;
    }

    backdrop.querySelector("#rs-save").addEventListener("click", async () => {
      try {
        const muted = backdrop.querySelector("#rs-mute").checked;
        await EchoAPI.post(`/api/rooms/${room.id}/mute`, { muted });

        let updated = room;
        if (canEdit) {
          const res = await EchoAPI.patch(`/api/rooms/${room.id}`, {
            name: backdrop.querySelector("#rs-name").value.trim(),
            description: backdrop.querySelector("#rs-desc").value.trim(),
            password: backdrop.querySelector("#rs-password").value || null,
            requireApproval: backdrop.querySelector("#rs-require-approval").checked,
          });
          updated = res.room;
        }
        upsertRoom({ ...updated, myRole, mutedByMe: muted });
        EchoToast.success("Room updated.");
        EchoModal.close();
        window.EchoApp.refreshHeader(updated);
      } catch (err) {
        EchoToast.error(err.message);
      }
    });

    backdrop.querySelector("#rs-leave").addEventListener("click", async () => {
      const ok = await EchoModal.confirm({ title: "Leave this room?", body: "You can rejoin later using the room code.", okLabel: "Leave" });
      if (!ok) return;
      try {
        await EchoAPI.post(`/api/rooms/${room.id}/leave`);
        removeRoom(room.id);
        EchoModal.close();
        window.EchoApp.closeRoom();
      } catch (err) {
        EchoToast.error(err.message);
      }
    });

    backdrop.querySelector("#rs-delete").addEventListener("click", async () => {
      const ok = await EchoModal.confirm({ title: "Delete this room permanently?", body: "This deletes all messages and cannot be undone.", okLabel: "Delete forever" });
      if (!ok) return;
      try {
        await EchoAPI.del(`/api/rooms/${room.id}`);
        removeRoom(room.id);
        EchoModal.close();
        window.EchoApp.closeRoom();
        EchoToast.success("Room deleted.");
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  /* ============================== Members / media panel ============================== */

  async function renderMembersTab(roomId, myRole) {
    const body = document.getElementById("details-body");
    body.innerHTML = `<div class="skeleton" style="height:44px;margin-bottom:8px;"></div><div class="skeleton" style="height:44px;"></div>`;
    try {
      const { members } = await EchoAPI.get(`/api/rooms/${roomId}/members`);
      body.innerHTML = members
        .map((m) => {
          const canModerate = ["owner", "admin"].includes(myRole) && m.role !== "owner";
          return `
        <div class="member-row" data-user-id="${m.id}" data-can-moderate="${canModerate}">
          <div class="avatar-wrap">
            ${m.avatar_url ? `<img class="avatar" src="${m.avatar_url}" style="width:34px;height:34px;" alt="" />` : `<div class="avatar-fallback" style="width:34px;height:34px;font-size:12px;">${initials(m.username)}</div>`}
            <span class="status-dot status-${m.status}" style="width:9px;height:9px;"></span>
          </div>
          <div style="min-width:0; flex:1;">
            <div class="member-name-row">${escapeHtml(m.username)} ${m.role !== "member" ? `<span class="badge badge-${m.role}">${m.role}</span>` : ""} ${m.muted ? "🔇" : ""}</div>
            <div class="member-sub">${m.status}</div>
          </div>
        </div>`;
        })
        .join("");

      body.querySelectorAll(".member-row").forEach((row) => {
        row.addEventListener("click", (e) => {
          if (row.dataset.canModerate !== "true") return;
          const rect = row.getBoundingClientRect();
          EchoContextMenu.open(rect.right, rect.top, [
            { label: "Promote to admin", onClick: () => moderate(roomId, row.dataset.userId, "promote") },
            { label: "Demote to member", onClick: () => moderate(roomId, row.dataset.userId, "demote") },
            { label: "Mute", onClick: () => moderate(roomId, row.dataset.userId, "mute") },
            { label: "Unmute", onClick: () => moderate(roomId, row.dataset.userId, "unmute") },
            "divider",
            { label: "Kick", danger: true, onClick: () => moderate(roomId, row.dataset.userId, "kick") },
            { label: "Ban", danger: true, onClick: () => moderate(roomId, row.dataset.userId, "ban") },
          ]);
        });
      });
    } catch (err) {
      body.innerHTML = `<p class="text-muted" style="padding:10px;">Couldn't load members.</p>`;
    }
  }

  async function moderate(roomId, userId, action) {
    try {
      await EchoAPI.post(`/api/rooms/${roomId}/moderate`, { userId, action });
      EchoToast.success(`Action applied: ${action}`);
      renderMembersTab(roomId, window.EchoApp.getMyRole());
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  const mediaTabState = { kind: "all", q: "", sort: "newest" };

  async function renderMediaTab(roomId) {
    const body = document.getElementById("details-body");
    body.innerHTML = `
      <div class="media-filter-bar">
        ${["all", "image", "video", "audio", "file", "links"]
          .map((k) => `<button class="media-filter-chip ${mediaTabState.kind === k ? "active" : ""}" data-kind="${k}">${{ all: "All", image: "Photos", video: "Videos", audio: "Audio", file: "Files", links: "Links" }[k]}</button>`)
          .join("")}
      </div>
      <div class="media-search-sort">
        <input class="input" id="media-search-input" placeholder="Search…" value="${escapeHtml(mediaTabState.q)}" />
        <select class="input" id="media-sort-select">
          <option value="newest" ${mediaTabState.sort === "newest" ? "selected" : ""}>Newest</option>
          <option value="oldest" ${mediaTabState.sort === "oldest" ? "selected" : ""}>Oldest</option>
        </select>
      </div>
      <div id="media-results"><div class="skeleton" style="height:100px; margin:0 12px;"></div></div>
    `;

    body.querySelectorAll(".media-filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => { mediaTabState.kind = chip.dataset.kind; renderMediaTab(roomId); });
    });
    body.querySelector("#media-search-input").addEventListener(
      "input",
      debounce((e) => { mediaTabState.q = e.target.value; loadMediaResults(roomId); }, 350)
    );
    body.querySelector("#media-sort-select").addEventListener("change", (e) => { mediaTabState.sort = e.target.value; loadMediaResults(roomId); });

    await loadMediaResults(roomId);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function loadMediaResults(roomId) {
    const results = document.getElementById("media-results");
    if (!results) return;
    try {
      const params = new URLSearchParams({ kind: mediaTabState.kind, sort: mediaTabState.sort });
      if (mediaTabState.q) params.set("q", mediaTabState.q);
      const { items } = await EchoAPI.get(`/api/rooms/${roomId}/media?${params.toString()}`);

      if (items.length === 0) {
        results.innerHTML = `<p class="text-muted" style="padding:14px 12px; font-size:13px;">Nothing found.</p>`;
        return;
      }

      if (mediaTabState.kind === "links") {
        results.innerHTML = items
          .map((i) => `<div class="link-row"><a href="${i.url}" target="_blank" rel="noopener">${escapeHtml(i.url)}</a><span>${escapeHtml(i.senderName)} · ${new Date(i.createdAt).toLocaleDateString()}</span></div>`)
          .join("");
        return;
      }

      const images = items.filter((i) => i.type === "image");
      const others = items.filter((i) => i.type !== "image");
      results.innerHTML = `
        ${images.length ? `<div class="media-grid" style="margin:0 12px 14px;">${images.map((i) => `<img src="${i.content}" alt="" data-src="${i.content}" />`).join("")}</div>` : ""}
        <div style="padding:0 12px;">
        ${others
          .map(
            (i) => `
          <div class="msg-file-chip" style="max-width:none; margin-bottom:6px;">
            <div class="file-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M13 2v7h7"/></svg></div>
            <div style="min-width:0;"><div class="msg-file-name">${escapeHtml(i.file_name || i.type)}</div><div class="msg-file-size">${i.file_size ? Math.round(i.file_size / 1024) + " KB" : ""}</div></div>
          </div>`
          )
          .join("")}
        </div>
      `;
      results.querySelectorAll(".media-grid img").forEach((img) => {
        img.addEventListener("click", () => window.open(img.dataset.src, "_blank"));
      });
    } catch (err) {
      results.innerHTML = `<p class="text-muted" style="padding:14px 12px;">Couldn't load media.</p>`;
    }
  }

  document.querySelectorAll(".details-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".details-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const roomId = window.EchoApp.getActiveRoomId();
      if (!roomId) return;
      if (tab.dataset.tab === "members") renderMembersTab(roomId, window.EchoApp.getMyRole());
      else renderMediaTab(roomId);
    });
  });

  /* ============================== Pending join requests (waiting room) ============================== */

  async function openPendingRequestsModal(roomId) {
    const backdrop = EchoModal.open("tpl-pending-requests");
    const list = backdrop.querySelector("#pending-requests-list");
    list.innerHTML = `<div class="skeleton" style="height:44px;"></div>`;

    async function refresh() {
      try {
        const { pending } = await EchoAPI.get(`/api/rooms/${roomId}/pending`);
        if (pending.length === 0) {
          list.innerHTML = `<p class="text-muted" style="font-size:13px;">No pending requests.</p>`;
          return;
        }
        list.innerHTML = pending
          .map(
            (p) => `
          <div class="room-item" style="cursor:default;">
            <div class="avatar-fallback" style="width:32px;height:32px;font-size:11px;">${p.username.slice(0, 2).toUpperCase()}</div>
            <div class="room-meta"><div class="room-name" style="font-size:13px;">${escapeHtml(p.username)}</div></div>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-secondary" style="padding:6px 12px; font-size:12px;" data-approve="${p.id}">Approve</button>
              <button class="btn btn-ghost" style="padding:6px 12px; font-size:12px; color:var(--danger);" data-reject="${p.id}">Reject</button>
            </div>
          </div>`
          )
          .join("");

        list.querySelectorAll("[data-approve]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await EchoAPI.post(`/api/rooms/${roomId}/pending/${btn.dataset.approve}/approve`);
            EchoToast.success("Approved.");
            refresh();
          });
        });
        list.querySelectorAll("[data-reject]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await EchoAPI.post(`/api/rooms/${roomId}/pending/${btn.dataset.reject}/reject`);
            EchoToast.info("Rejected.");
            refresh();
          });
        });
      } catch (err) {
        list.innerHTML = `<p class="text-muted" style="font-size:13px;">Couldn't load pending requests.</p>`;
      }
    }
    refresh();
  }

  window.EchoRooms = {
    load: loadRooms,
    setActive: setActiveRoom,
    upsert: upsertRoom,
    remove: removeRoom,
    openJoinModal,
    openRoomSettings,
    renderMembersTab,
    getAll: () => rooms,
  };
})();
