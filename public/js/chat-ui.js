(function () {
  "use strict";

  const messagesList = document.getElementById("messages-list");
  const chatBody = document.getElementById("chat-body");
  const composerForm = document.getElementById("composer-form");
  const composerInput = document.getElementById("composer-input");
  const sendBtn = document.getElementById("btn-send");
  const typingIndicator = document.getElementById("typing-indicator");
  const replyPreview = document.getElementById("reply-preview");
  const uploadSlot = document.getElementById("upload-progress-slot");
  const pinnedBanner = document.getElementById("pinned-banner");

  let starredIds = new Set();

  async function loadStarredIds() {
    try {
      const { starred } = await EchoAPI.get("/api/users/me/starred");
      starredIds = new Set(starred.map((s) => s.id));
    } catch (e) { starredIds = new Set(); }
  }
  loadStarredIds();

  /* ---- Search ---- */
  const searchBar = document.getElementById("search-bar");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  let searchDebounce = null;

  document.getElementById("btn-search-messages").addEventListener("click", () => {
    searchBar.classList.remove("hidden");
    searchBar.style.display = "flex";
    searchInput.focus();
  });
  document.getElementById("btn-close-search").addEventListener("click", closeSearch);
  function closeSearch() {
    searchBar.classList.add("hidden");
    searchBar.style.display = "none";
    searchResults.classList.add("hidden");
    searchInput.value = "";
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (q.length < 2) { searchResults.classList.add("hidden"); return; }
    searchDebounce = setTimeout(async () => {
      try {
        const { results } = await EchoAPI.get(`/api/rooms/${currentRoom.id}/messages/search?q=${encodeURIComponent(q)}`);
        renderSearchResults(results, q);
      } catch (err) { /* ignore transient search errors */ }
    }, 300);
  });

  function renderSearchResults(results, q) {
    searchResults.classList.remove("hidden");
    if (results.length === 0) {
      searchResults.innerHTML = `<p class="text-muted" style="padding:14px 22px; font-size:13px;">No messages match "${escapeHtml(q)}".</p>`;
      return;
    }
    searchResults.innerHTML = results
      .map(
        (r) => `
      <div class="room-item" data-jump-search="${r.id}" style="border-radius:0; padding:10px 22px;">
        <div class="room-meta">
          <div class="room-name" style="font-weight:600; font-size:13px;">${escapeHtml(r.senderName)} <span class="text-muted" style="font-weight:400;">${formatTime(r.createdAt)}</span></div>
          <div class="room-sub">${escapeHtml((r.content || "").slice(0, 90))}</div>
        </div>
      </div>`
      )
      .join("");
    searchResults.querySelectorAll("[data-jump-search]").forEach((el) => {
      el.addEventListener("click", async () => {
        closeSearch();
        await jumpToMessage(el.dataset.jumpSearch);
      });
    });
  }

  async function jumpToMessage(messageId) {
    let target = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!target) {
      // Not currently loaded — pull older history until we find it (bounded
      // to a reasonable number of pages so a very old message can't hang).
      for (let i = 0; i < 20 && !target; i++) {
        const before = messages.length ? messages[0].createdAt : Date.now();
        const { messages: older } = await EchoAPI.get(`/api/rooms/${currentRoom.id}/messages?before=${before}&limit=50`);
        if (older.length === 0) break;
        messages = [...older, ...messages];
        oldestLoadedTs = older[0].createdAt;
        renderAll();
        target = document.querySelector(`[data-message-id="${messageId}"]`);
      }
    }
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.style.background = "var(--surface-hover)";
      setTimeout(() => (target.style.background = ""), 1000);
    } else {
      EchoToast.error("Couldn't locate that message.");
    }
  }

  async function toggleStar(messageId) {
    try {
      if (starredIds.has(messageId)) {
        await EchoAPI.del(`/api/messages/${messageId}/star`);
        starredIds.delete(messageId);
        EchoToast.info("Removed from starred.");
      } else {
        await EchoAPI.post(`/api/messages/${messageId}/star`);
        starredIds.add(messageId);
        EchoToast.success("Starred.");
      }
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  function openForwardModal(m) {
    const backdrop = EchoModal.open("tpl-forward");
    const list = backdrop.querySelector("#forward-room-list");
    const rooms = window.EchoRooms.getAll().filter((r) => r.id !== currentRoom.id);
    if (rooms.length === 0) {
      list.innerHTML = `<p class="text-muted" style="font-size:13px;">You don't have any other rooms to forward to.</p>`;
      return;
    }
    list.innerHTML = rooms
      .map((r) => `<div class="room-item" data-room-id="${r.id}"><div class="room-icon" style="width:34px;height:34px;font-size:12px;">${escapeHtml(r.name.slice(0, 2).toUpperCase())}</div><div class="room-meta"><div class="room-name">${escapeHtml(r.name)}</div></div></div>`)
      .join("");
    list.querySelectorAll("[data-room-id]").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await EchoSocket.emitAck("message:send", {
            roomId: el.dataset.roomId,
            type: m.type,
            content: m.content,
            fileName: m.fileName,
            fileSize: m.fileSize,
            fileType: m.fileType,
            forwardedFrom: m.senderName,
          });
          EchoToast.success("Message forwarded.");
          EchoModal.close();
        } catch (err) {
          EchoToast.error(err.message);
        }
      });
    });
  }

  function openReportModal({ targetUserId, messageId, title }) {
    const backdrop = EchoModal.open("tpl-report");
    backdrop.querySelector("#report-title").textContent = title || "Report";
    backdrop.querySelector("#report-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await EchoAPI.post("/api/reports", { targetUserId, messageId, reason: backdrop.querySelector("#report-reason").value });
        EchoToast.success("Report submitted. Thank you.");
        EchoModal.close();
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  async function blockSender(userId, username) {
    const ok = await EchoModal.confirm({ title: `Block ${username}?`, body: "You won't see their messages anymore.", okLabel: "Block" });
    if (!ok) return;
    try {
      await EchoAPI.post(`/api/users/${userId}/block`);
      EchoToast.success(`Blocked ${username}.`);
      renderAll();
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  let blockedIds = new Set();
  async function loadBlockedIds() {
    try {
      const { blocked } = await EchoAPI.get("/api/users/me/blocked");
      blockedIds = new Set(blocked.map((b) => b.id));
    } catch (e) { blockedIds = new Set(); }
  }
  loadBlockedIds();

  let messages = [];
  let currentUser = null;
  let currentRoom = null;
  let replyTarget = null;
  let typingUsers = new Map();
  let recordingUsers = new Map();
  let typingTimeout = null;
  let oldestLoadedTs = null;
  let loadingOlder = false;

  const EMOJI_QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function formatDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
  }

  function initials(name) {
    return (name || "?").trim().slice(0, 2).toUpperCase();
  }

  function fileTypeIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M13 2v7h7"/></svg>`;
  }

  /* ============================== Init / reset for a room ============================== */

  let memberLastRead = new Map(); // userId -> last_read_at (ms)

  function setContext(user, room) {
    currentUser = user;
    currentRoom = room;
    messages = [];
    typingUsers.clear();
    recordingUsers.clear();
    oldestLoadedTs = null;
    memberLastRead = new Map();
    messagesList.innerHTML = "";
    renderTyping();
  }

  function setMemberLastReadMap(members) {
    memberLastRead = new Map(members.filter((m) => m.id !== currentUser.id).map((m) => [m.id, m.last_read_at || 0]));
  }

  function isSeenByAnyoneElse(m) {
    for (const [, lastReadAt] of memberLastRead) {
      if (lastReadAt >= m.createdAt) return true;
    }
    return false;
  }

  function onSeen({ userId, at }) {
    memberLastRead.set(userId, at);
    renderAll(); // cheap enough at these message-list sizes; re-derives receipt state for all of "my" messages
  }

  async function loadInitialMessages() {
    messagesList.innerHTML = `<div class="skeleton" style="height:40px;margin-bottom:10px;width:60%;"></div><div class="skeleton" style="height:40px;margin-bottom:10px;width:40%;margin-left:auto;"></div><div class="skeleton" style="height:40px;width:55%;"></div>`;
    try {
      const { messages: list } = await EchoAPI.get(`/api/rooms/${currentRoom.id}/messages?limit=50`);
      messages = list;
      oldestLoadedTs = list.length ? list[0].createdAt : Date.now();
      renderAll();
      scrollToBottom();
      updatePinnedBanner();
    } catch (err) {
      messagesList.innerHTML = `<p class="text-muted" style="text-align:center; padding:20px;">Couldn't load messages.</p>`;
    }
  }

  async function loadOlderMessages() {
    if (loadingOlder || !oldestLoadedTs) return;
    loadingOlder = true;
    const prevHeight = chatBody.scrollHeight;
    try {
      const { messages: older } = await EchoAPI.get(`/api/rooms/${currentRoom.id}/messages?before=${oldestLoadedTs}&limit=40`);
      if (older.length) {
        messages = [...older, ...messages];
        oldestLoadedTs = older[0].createdAt;
        renderAll();
        chatBody.scrollTop = chatBody.scrollHeight - prevHeight;
      }
    } catch (err) { /* silent — user can retry by scrolling again */ }
    loadingOlder = false;
  }

  chatBody.addEventListener("scroll", () => {
    if (chatBody.scrollTop < 80) loadOlderMessages();
  });

  /* ============================== Rendering ============================== */

  function renderAll() {
    messagesList.innerHTML = "";
    let lastDay = null;
    let lastSenderId = null;
    let lastTs = 0;

    messages.forEach((m) => {
      if (m.senderId && m.senderId !== currentUser.id && blockedIds.has(m.senderId)) return;
      const day = formatDay(m.createdAt);
      if (day !== lastDay) {
        const divider = document.createElement("div");
        divider.className = "day-divider";
        divider.textContent = day;
        messagesList.appendChild(divider);
        lastDay = day;
        lastSenderId = null;
      }
      const grouped = m.senderId === lastSenderId && m.createdAt - lastTs < 5 * 60 * 1000 && m.type !== "system";
      messagesList.appendChild(renderMessage(m, grouped));
      lastSenderId = m.senderId;
      lastTs = m.createdAt;
    });

    if (window.hljs) {
      messagesList.querySelectorAll("pre code").forEach((block) => { try { hljs.highlightElement(block); } catch (e) {} });
    }
    initLeafletMaps(messagesList);
  }

  function renderMessage(m, grouped) {
    const row = document.createElement("div");
    row.dataset.messageId = m.id;
    const mine = m.senderId === currentUser.id;
    row.className = `msg-row ${mine ? "mine" : ""} ${grouped ? "grouped" : ""} ${m.type === "system" ? "system" : ""}`;

    if (m.type === "system") {
      row.innerHTML = `<div class="msg-bubble">${escapeHtml(m.content)}</div>`;
      return row;
    }

    const replyHtml = m.replyToId ? renderReplyRef(m.replyToId) : "";
    const bodyHtml = renderBody(m);
    const reactionsHtml = renderReactions(m);
    const threadBadge = m.replyCount > 0 ? `<div class="thread-reply-badge" data-thread-root="${m.id}">💬 ${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}</div>` : "";
    const receiptHtml = mine && !m.deletedAt ? renderReceipt(m) : "";

    row.innerHTML = `
      <div class="msg-avatar-slot">${renderAvatar(m)}</div>
      <div class="msg-content">
        ${grouped ? "" : `<div class="msg-head"><span class="msg-author">${escapeHtml(m.senderName)}</span><span class="msg-time ${m.editedAt ? "edited" : ""}">${formatTime(m.createdAt)}${m.pinned ? " 📌" : ""}</span></div>`}
        ${replyHtml}
        ${bodyHtml}${receiptHtml}
        ${reactionsHtml}
        ${threadBadge}
      </div>
      <div class="msg-actions">
        <button class="act-react" title="React">${"\u{1F60A}"}</button>
        <button class="act-reply" title="Reply">↩</button>
        ${m.type === "text" && mine ? `<button class="act-edit" title="Edit">✎</button>` : ""}
        ${!m.deletedAt ? `<button class="act-more" title="More">⋯</button>` : ""}
      </div>
    `;

    bindMessageActions(row, m, mine);
    return row;
  }

  function renderReceipt(m) {
    const seen = isSeenByAnyoneElse(m);
    return `<span class="msg-receipt ${seen ? "seen" : ""}" title="${seen ? "Seen" : "Sent"}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/>${seen ? '<path d="m24 6-11 11-2-2" transform="translate(-4)"/>' : ""}</svg>
    </span>`;
  }

  function renderAvatar(m) {
    return `<div class="avatar-fallback" style="width:32px;height:32px;font-size:11px;">${initials(m.senderName)}</div>`;
  }

  function renderReplyRef(replyToId) {
    const target = messages.find((x) => x.id === replyToId);
    if (!target) return `<div class="msg-reply-ref">Replying to a message</div>`;
    return `<div class="msg-reply-ref" data-jump="${target.id}"><b>${escapeHtml(target.senderName)}</b>: ${escapeHtml((target.content || "").slice(0, 60))}</div>`;
  }

  function isJumboEmojiOnly(text) {
    if (!text) return false;
    // Matches a short run (1-4) of emoji-ish codepoints and nothing else —
    // used to render single-emoji messages bigger, like a lightweight
    // built-in "sticker" (no external sticker assets involved).
    const stripped = text.trim();
    const emojiRe = /^(\p{Extended_Pictographic}\uFE0F?\u200D?){1,4}$/u;
    return stripped.length > 0 && stripped.length <= 16 && emojiRe.test(stripped);
  }

  function highlightMentions(html, mentions) {
    if (!mentions || mentions.length === 0) return html;
    let out = html;
    for (const username of mentions) {
      const re = new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      out = out.replace(re, `<span class="msg-mention">@${username}</span>`);
    }
    return out;
  }

  function renderBody(m) {
    if (m.deletedAt) return `<div class="msg-bubble deleted">Message deleted</div>`;
    const forwardedTag = m.forwardedFrom
      ? `<div style="font-size:11px; color:var(--text-faint); display:flex; align-items:center; gap:4px; margin-bottom:2px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>Forwarded from ${escapeHtml(m.forwardedFrom)}</div>`
      : "";
    switch (m.type) {
      case "text": {
        if (isJumboEmojiOnly(m.content)) {
          return `${forwardedTag}<div class="msg-bubble jumbo-emoji">${escapeHtml(m.content)}</div>`;
        }
        const rendered = highlightMentions(renderMarkdown(escapeHtml(m.content)), m.mentions);
        return `${forwardedTag}<div class="msg-bubble">${rendered}</div>`;
      }
      case "announcement":
        return `<div class="announcement-bubble"><span style="font-size:18px;">📣</span><div>${highlightMentions(renderMarkdown(escapeHtml(m.content)), m.mentions)}</div></div>`;
      case "image":
        return `${forwardedTag}<div class="msg-bubble media-bubble"><img class="msg-image" src="${m.content}" alt="Shared image" loading="lazy" /></div>`;
      case "gif":
        return `${forwardedTag}<div class="msg-bubble media-bubble"><img class="msg-image" src="${m.content}" alt="GIF" loading="lazy" /></div>`;
      case "video":
        return `${forwardedTag}<div class="msg-bubble media-bubble"><video src="${m.content}" controls style="max-width:320px; border-radius:var(--radius-md); display:block;"></video></div>`;
      case "audio":
        return `${forwardedTag}<div class="msg-bubble media-bubble">${renderVoiceNote(m)}</div>`;
      case "file":
        return `${forwardedTag}<div class="msg-bubble media-bubble">
          <a class="msg-file-chip" href="${m.content}" download="${escapeHtml(m.fileName || "")}" target="_blank" rel="noopener">
            <div class="file-icon">${fileTypeIcon()}</div>
            <div style="min-width:0;"><div class="msg-file-name">${escapeHtml(m.fileName || "File")}</div><div class="msg-file-size">${m.fileSize ? Math.round(m.fileSize / 1024) + " KB" : ""}</div></div>
          </a>
        </div>`;
      case "poll":
        return renderPoll(m);
      case "location":
        return renderLocation(m);
      default:
        return `<div class="msg-bubble">${escapeHtml(m.content)}</div>`;
    }
  }

  function renderPoll(m) {
    if (!m.poll) return `<div class="msg-bubble">Poll unavailable</div>`;
    const { id, question, options, tally, totalVotes, myVotes, closed, createdBy } = m.poll;
    const canManage = createdBy === currentUser.id || ["owner", "admin"].includes(window.EchoApp.getMyRole());
    return `
      <div class="poll-card" data-poll-id="${id}">
        <div class="poll-question">📊 ${escapeHtml(question)}</div>
        ${options
          .map((opt, i) => {
            const pct = totalVotes ? Math.round(((tally[i] || 0) / totalVotes) * 100) : 0;
            const voted = myVotes.includes(i);
            return `<div class="poll-option ${voted ? "voted" : ""}" data-poll-vote="${i}">
              <div class="poll-option-fill" style="width:${pct}%;"></div>
              <span class="poll-option-label">${voted ? "✓ " : ""}${escapeHtml(opt)}</span>
              <span class="poll-option-count">${tally[i] || 0} (${pct}%)</span>
            </div>`;
          })
          .join("")}
        <div class="poll-meta">
          <span>${totalVotes} vote${totalVotes === 1 ? "" : "s"}${closed ? " · closed" : ""}</span>
          ${!closed && canManage ? `<button class="poll-close-btn" data-poll-close="${id}">Close poll</button>` : ""}
        </div>
      </div>`;
  }

  function renderLocation(m) {
    let coords;
    try { coords = JSON.parse(m.content); } catch (e) { return `<div class="msg-bubble">📍 Location unavailable</div>`; }
    const isLive = m.locationLiveUntil && m.locationLiveUntil > Date.now();
    const mapId = "map-" + m.id;
    return `
      <div class="location-card" data-location-id="${m.id}" data-lat="${coords.lat}" data-lng="${coords.lng}">
        <div class="location-map" id="${mapId}"></div>
        <div class="location-footer">
          <span>${isLive ? `<span class="location-live-badge">Live</span>` : "📍 Location"}</span>
          <a href="https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lng}#map=15/${coords.lat}/${coords.lng}" target="_blank" rel="noopener" style="color:var(--accent);">Open map</a>
        </div>
      </div>`;
  }

  function initLeafletMaps(container) {
    if (!window.L) return;
    container.querySelectorAll(".location-card").forEach((card) => {
      const mapId = card.querySelector(".location-map").id;
      if (card.dataset.mapInited) return;
      card.dataset.mapInited = "1";
      const lat = parseFloat(card.dataset.lat), lng = parseFloat(card.dataset.lng);
      const map = L.map(mapId, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false }).setView([lat, lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
      const marker = L.marker([lat, lng]).addTo(map);
      card._map = map;
      card._marker = marker;
    });
  }

  function renderVoiceNote(m) {
    const id = "vn-" + m.id;
    // Bar heights are randomized once per message (stable across re-renders
    // via a seeded look) purely for visual texture; what's real is that they
    // light up left-to-right in sync with actual playback progress below.
    const heights = Array.from({ length: 24 }).map(() => 6 + Math.random() * 16);
    return `
      <div class="voice-note">
        <button class="voice-note-play" data-audio-src="${m.content}" data-audio-id="${id}" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="play-icon"><path d="m3 3 18 9-18 9V3Z"/></svg>
        </button>
        <div class="voice-note-wave" id="wave-${id}">${heights.map((h) => `<span style="height:${h}px;"></span>`).join("")}</div>
        <button type="button" class="voice-note-speed" data-audio-id="${id}" style="font-size:10.5px; font-weight:700; color:var(--text-muted); background:var(--surface-2); border:none; border-radius:10px; padding:2px 6px; flex-shrink:0; cursor:pointer;">1x</button>
        <span class="mono" id="time-${id}" style="font-size:10.5px; color:var(--text-muted); flex-shrink:0;">0:00</span>
        <audio id="${id}" src="${m.content}" preload="metadata"></audio>
      </div>`;
  }

  function renderReactions(m) {
    if (!m.reactions || m.reactions.length === 0) return "";
    const grouped = {};
    m.reactions.forEach((r) => {
      grouped[r.emoji] = grouped[r.emoji] || [];
      grouped[r.emoji].push(r.userId);
    });
    return `<div class="msg-reactions">${Object.entries(grouped)
      .map(([emoji, userIds]) => `<span class="reaction-pill ${userIds.includes(currentUser.id) ? "mine" : ""}" data-emoji="${emoji}">${emoji} ${userIds.length}</span>`)
      .join("")}</div>`;
  }

  function linkify(text) {
    return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:underline;">$1</a>');
  }

  /** Minimal, SAFE Markdown: operates on already-HTML-escaped text, so the
   * only HTML it ever introduces is the fixed tags below — no raw user HTML
   * can slip through. Supports: ```code blocks```, `inline code`, **bold**,
   * *italic*, ~~strikethrough~~, and (via linkify) auto-linked URLs. */
  function renderMarkdown(escapedText) {
    const codeBlocks = [];
    let text = escapedText.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code.trim());
      return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
    });

    const inlineCode = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCode.push(code);
      return `\u0000INLINECODE${inlineCode.length - 1}\u0000`;
    });

    text = text
      .replace(/\*\*([^\n*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^\n*]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/~~([^\n~]+)~~/g, "<del>$1</del>");

    text = linkify(text);

    text = text.replace(/\u0000INLINECODE(\d+)\u0000/g, (_, i) => `<code style="background:var(--surface-2); padding:1px 6px; border-radius:5px; font-family:var(--font-mono); font-size:0.9em;">${inlineCode[+i]}</code>`);
    text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => `<pre style="background:var(--surface-2); padding:10px 12px; border-radius:8px; overflow-x:auto; margin:4px 0;"><code style="font-family:var(--font-mono); font-size:0.85em; white-space:pre;">${codeBlocks[+i]}</code></pre>`);

    return text;
  }

  function updatePinnedBanner() {
    const pinned = messages.filter((m) => m.pinned && !m.deletedAt);
    if (pinned.length === 0) { pinnedBanner.classList.add("hidden"); return; }
    const last = pinned[pinned.length - 1];
    pinnedBanner.classList.remove("hidden");
    pinnedBanner.innerHTML = `📌 <b>${escapeHtml(last.senderName)}</b>: ${escapeHtml((last.content || "").slice(0, 80))}`;
  }

  function scrollToBottom() {
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  /* ============================== Message actions ============================== */

  function bindMessageActions(row, m, mine) {
    row.querySelectorAll("[data-poll-vote]").forEach((el) => {
      el.addEventListener("click", async () => {
        if (!m.poll || m.poll.closed) return;
        try {
          await EchoSocket.emitAck("poll:vote", { roomId: currentRoom.id, pollId: m.poll.id, optionIndex: parseInt(el.dataset.pollVote, 10) });
        } catch (err) {
          EchoToast.error(err.message);
        }
      });
    });
    row.querySelector("[data-poll-close]")?.addEventListener("click", async (e) => {
      try {
        await EchoSocket.emitAck("poll:close", { roomId: currentRoom.id, pollId: e.currentTarget.dataset.pollClose });
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
    row.querySelector("[data-thread-root]")?.addEventListener("click", (e) => {
      window.EchoThread?.open(e.currentTarget.dataset.threadRoot);
    });

    row.querySelector(".act-react")?.addEventListener("click", (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      EchoContextMenu.open(
        rect.left,
        rect.top - 44,
        EMOJI_QUICK.map((emoji) => ({ label: emoji, onClick: () => react(m.id, emoji) }))
      );
    });

    row.querySelector(".act-reply")?.addEventListener("click", () => setReplyTarget(m));

    row.querySelector(".act-edit")?.addEventListener("click", () => beginEdit(row, m));

    row.querySelector(".act-more")?.addEventListener("click", (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const canModerate = ["owner", "admin"].includes(window.EchoApp.getMyRole());
      const items = [];
      items.push({ label: "Copy text", onClick: () => navigator.clipboard.writeText(m.content || "") });
      items.push({ label: starredIds.has(m.id) ? "★ Unstar" : "☆ Star", onClick: () => toggleStar(m.id) });
      items.push({ label: "↪ Forward", onClick: () => openForwardModal(m) });
      items.push({ label: m.pinned ? "Unpin" : "Pin", onClick: () => togglePin(m) });
      if (!mine) {
        items.push("divider");
        items.push({ label: "Report message", onClick: () => openReportModal({ messageId: m.id, title: `Report message from ${m.senderName}` }) });
        items.push({ label: `Block ${m.senderName}`, danger: true, onClick: () => blockSender(m.senderId, m.senderName) });
      }
      if (mine || canModerate) items.push("divider", { label: "Delete", danger: true, onClick: () => deleteMessage(m.id) });
      EchoContextMenu.open(rect.right - 190, rect.bottom, items);
    });

    row.querySelector(".msg-reply-ref")?.addEventListener("click", (e) => {
      const target = document.querySelector(`[data-message-id="${e.currentTarget.dataset.jump}"]`);
      if (target) { target.scrollIntoView({ behavior: "smooth", block: "center" }); target.style.background = "var(--surface-hover)"; setTimeout(() => (target.style.background = ""), 900); }
    });

    row.querySelectorAll(".reaction-pill").forEach((pill) => {
      pill.addEventListener("click", () => react(m.id, pill.dataset.emoji));
    });

    row.querySelector(".voice-note-speed")?.addEventListener("click", (e) => {
      const audio = document.getElementById(e.currentTarget.dataset.audioId);
      if (!audio) return;
      const speeds = [1, 1.5, 2];
      const currentIdx = speeds.indexOf(audio.playbackRate);
      const next = speeds[(currentIdx + 1) % speeds.length];
      audio.playbackRate = next;
      e.currentTarget.textContent = next + "x";
    });

    row.querySelector(".voice-note-play")?.addEventListener("click", (e) => {
      const audioId = e.currentTarget.dataset.audioId;
      const audio = document.getElementById(audioId);
      const playIcon = e.currentTarget.querySelector(".play-icon");
      if (!audio) return;

      if (audio.paused) {
        document.querySelectorAll("audio").forEach((a) => { if (a !== audio) a.pause(); });
        const playPromise = audio.play();
        if (playPromise && playPromise.catch) {
          playPromise.catch((err) => EchoToast.error("Couldn't play voice note: " + err.message));
        }
      } else {
        audio.pause();
      }
    });
  }

  function beginEdit(row, m) {
    const bubble = row.querySelector(".msg-bubble");
    const original = m.content;
    bubble.innerHTML = `<textarea class="input" style="min-height:60px;">${escapeHtml(original)}</textarea><div style="display:flex; gap:8px; margin-top:6px;"><button class="btn btn-primary" style="padding:6px 14px; font-size:12px;" id="edit-save">Save</button><button class="btn btn-ghost" style="padding:6px 14px; font-size:12px;" id="edit-cancel">Cancel</button></div>`;
    const textarea = bubble.querySelector("textarea");
    textarea.focus();
    bubble.querySelector("#edit-cancel").addEventListener("click", () => renderAll());
    bubble.querySelector("#edit-save").addEventListener("click", async () => {
      const content = textarea.value.trim();
      if (!content) return;
      try {
        await EchoSocket.emitAck("message:edit", { roomId: currentRoom.id, messageId: m.id, content });
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  async function deleteMessage(messageId) {
    const ok = await EchoModal.confirm({ title: "Delete this message?", body: "This can't be undone.", okLabel: "Delete" });
    if (!ok) return;
    try {
      await EchoSocket.emitAck("message:delete", { roomId: currentRoom.id, messageId });
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  async function togglePin(m) {
    try {
      await EchoSocket.emitAck("message:pin", { roomId: currentRoom.id, messageId: m.id, pinned: !m.pinned });
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  async function react(messageId, emoji) {
    try {
      await EchoSocket.emitAck("message:react", { roomId: currentRoom.id, messageId, emoji });
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  function setReplyTarget(m) {
    replyTarget = m;
    replyPreview.classList.add("active");
    document.getElementById("reply-preview-name").textContent = m.senderName;
    document.getElementById("reply-preview-text").textContent = m.content || "(attachment)";
    composerInput.focus();
  }

  document.getElementById("btn-cancel-reply").addEventListener("click", () => {
    replyTarget = null;
    replyPreview.classList.remove("active");
  });

  /* ============================== Socket event handlers ============================== */

  function onMessageNew(m) {
    if (m.roomId !== currentRoom?.id) {
      EchoToast.info(`New message in another room`);
      return;
    }
    messages.push(m);
    const wasNearBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 120;
    renderAll();
    if (wasNearBottom || m.senderId === currentUser.id) scrollToBottom();
    typingUsers.delete(m.senderId);
    renderTyping();
  }

  function onMessageEdited({ id, content, editedAt }) {
    const msg = messages.find((m) => m.id === id);
    if (msg) { msg.content = content; msg.editedAt = editedAt; renderAll(); }
  }

  function onMessageDeleted({ id }) {
    const msg = messages.find((m) => m.id === id);
    if (msg) { msg.deletedAt = Date.now(); msg.content = ""; renderAll(); }
  }

  function onMessagePinned({ id, pinned }) {
    const msg = messages.find((m) => m.id === id);
    if (msg) { msg.pinned = pinned; renderAll(); updatePinnedBanner(); }
  }

  function onReaction({ messageId, userId, emoji, removed }) {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.reactions = msg.reactions || [];
    if (removed) msg.reactions = msg.reactions.filter((r) => !(r.userId === userId && r.emoji === emoji));
    else msg.reactions.push({ userId, emoji });
    renderAll();
  }

  function onTyping({ userId, username, isTyping }) {
    if (userId === currentUser.id) return;
    if (isTyping) typingUsers.set(userId, username);
    else typingUsers.delete(userId);
    renderTyping();
  }

  function onVoiceRecording({ userId, username, isRecording, status }) {
    if (userId === currentUser.id) return;
    if (isRecording) recordingUsers.set(userId, { username, status: status === "uploading" ? "uploading" : "recording" });
    else recordingUsers.delete(userId);
    renderTyping();
  }

  function renderTyping() {
    // Recording/uploading takes priority over typing in the label when both
    // are somehow active — recording someone a voice note isn't "typing" in
    // any useful sense, so there's no need to show both at once.
    if (recordingUsers.size > 0) {
      const entries = [...recordingUsers.values()];
      const verb = entries.some((e) => e.status === "uploading") ? "sending a voice message" : "recording a voice message";
      const names = entries.map((e) => e.username);
      const label = names.length === 1 ? `${names[0]} is ${verb}` : `${names.slice(0, 2).join(", ")} are ${verb.replace("a voice message", "voice messages")}`;
      typingIndicator.innerHTML = `${escapeHtml(label)}<span class="typing-dots"><span></span><span></span><span></span></span>`;
      return;
    }
    const names = [...typingUsers.values()];
    if (names.length === 0) { typingIndicator.innerHTML = ""; return; }
    const label = names.length === 1 ? `${names[0]} is typing` : `${names.slice(0, 2).join(", ")} are typing`;
    typingIndicator.innerHTML = `${escapeHtml(label)}<span class="typing-dots"><span></span><span></span><span></span></span>`;
  }

  /* ============================== Composer ============================== */

  composerInput.addEventListener("input", () => {
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 140) + "px";
    sendBtn.disabled = composerInput.value.trim().length === 0;

    EchoSocket.emit("typing", { roomId: currentRoom.id, isTyping: composerInput.value.length > 0 });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => EchoSocket.emit("typing", { roomId: currentRoom.id, isTyping: false }), 2000);
  });

  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composerForm.requestSubmit();
    }
  });

  composerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = composerInput.value.trim();
    if (!content) return;
    composerInput.value = "";
    composerInput.style.height = "auto";
    sendBtn.disabled = true;
    await sendMessage({ type: "text", content });
  });

  async function sendMessage(payload) {
    try {
      await EchoSocket.emitAck("message:send", {
        roomId: currentRoom.id,
        replyToId: replyTarget?.id || null,
        ...payload,
      });
      replyTarget = null;
      replyPreview.classList.remove("active");
      EchoSocket.emit("typing", { roomId: currentRoom.id, isTyping: false });
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  /* ============================== File / image upload ============================== */

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.className = "hidden";
  document.body.appendChild(fileInput);

  document.getElementById("btn-attach-file").addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (file) previewThenUpload(file);
  });

  function previewThenUpload(file) {
    const backdrop = EchoModal.open("tpl-attach-preview");
    const slot = backdrop.querySelector("#attach-preview-slot");
    const url = URL.createObjectURL(file);

    if (file.type.startsWith("image/")) {
      slot.innerHTML = `<img class="attach-preview-media" src="${url}" alt="Preview" />`;
    } else if (file.type.startsWith("video/")) {
      slot.innerHTML = `<video class="attach-preview-media" src="${url}" controls></video>`;
    } else {
      slot.innerHTML = `
        <div class="msg-file-chip" style="max-width:none;">
          <div class="file-icon">${fileTypeIcon()}</div>
          <div style="min-width:0;"><div class="msg-file-name">${escapeHtml(file.name)}</div><div class="msg-file-size">${Math.round(file.size / 1024)} KB</div></div>
        </div>`;
    }

    backdrop.querySelector("#attach-preview-cancel").addEventListener("click", () => {
      URL.revokeObjectURL(url);
      EchoModal.close();
    });
    backdrop.querySelector("#attach-preview-send").addEventListener("click", async () => {
      URL.revokeObjectURL(url);
      EchoModal.close();
      await uploadAndSend(file);
    });
  }

  async function uploadAndSend(file) {
    const progressEl = document.createElement("div");
    progressEl.className = "upload-progress";
    progressEl.innerHTML = `<span>${escapeHtml(file.name)}</span><div class="upload-progress-bar"><div class="upload-progress-fill" id="upfill"></div></div>`;
    uploadSlot.appendChild(progressEl);

    try {
      const formData = new FormData();
      formData.append("attachment", file);
      const result = await uploadWithProgress(formData, (pct) => {
        const fill = progressEl.querySelector("#upfill");
        if (fill) fill.style.width = pct + "%";
      });

      let type = "file";
      if (file.type.startsWith("image/")) type = "image";
      else if (file.type.startsWith("video/")) type = "video";
      else if (file.type.startsWith("audio/")) type = "audio";

      await sendMessage({ type, content: result.url, fileName: result.fileName, fileSize: result.fileSize, fileType: result.fileType });
      progressEl.remove();
    } catch (err) {
      // Keep the original file/blob (a recorded voice note especially can't
      // just be recreated) instead of discarding it with only a toast —
      // offer to retry the exact same upload, e.g. after the connection
      // that dropped mid-upload comes back.
      showUploadFailed(progressEl, file, err);
    }
  }

  function showUploadFailed(progressEl, file, err) {
    progressEl.classList.add("upload-progress-failed");
    progressEl.innerHTML = `
      <span class="upload-error-text" style="color:var(--danger, #e5484d); font-size:12.5px;">⚠️ ${escapeHtml(err?.message || "Upload failed")}</span>
      <div style="display:flex; gap:6px; margin-left:auto;">
        <button type="button" class="upload-retry-btn" style="font-size:12px; font-weight:600; padding:3px 10px; border-radius:8px; border:none; background:var(--accent); color:#fff; cursor:pointer;">Retry</button>
        <button type="button" class="upload-dismiss-btn" style="font-size:12px; padding:3px 10px; border-radius:8px; border:none; background:var(--surface-2); color:var(--text-muted); cursor:pointer;">Dismiss</button>
      </div>`;
    progressEl.querySelector(".upload-retry-btn").addEventListener("click", () => {
      progressEl.remove();
      uploadAndSend(file);
    });
    progressEl.querySelector(".upload-dismiss-btn").addEventListener("click", () => progressEl.remove());
  }

  function uploadWithProgress(formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error((JSON.parse(xhr.responseText || "{}").error) || "Upload failed."));
      };
      xhr.onerror = () => reject(new Error("Upload failed — check your connection."));
      xhr.send(formData);
    });
  }

  /* ---- Drag & drop + clipboard paste ---- */
  ["dragover", "dragenter"].forEach((evt) => chatBody.addEventListener(evt, (e) => e.preventDefault()));
  chatBody.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) previewThenUpload(file);
  });
  composerInput.addEventListener("paste", (e) => {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
    if (item) previewThenUpload(item.getAsFile());
  });

  /* ============================== Voice notes ============================== */

  const voiceBtn = document.getElementById("btn-voice-note");
  const sendRecordingBtn = document.getElementById("btn-send-recording");
  const composerFormEl = document.getElementById("composer-form");

  const MIME_EXT = {
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  function extForMimeType(mimeType) {
    const base = (mimeType || "audio/webm").split(";")[0].trim();
    return MIME_EXT[base] || "webm";
  }

  voiceBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (EchoRecorder.isRecording() || EchoRecorder.isPaused()) return; // ignore accidental double taps
    composerFormEl.classList.add("is-recording");
    try {
      await EchoRecorder.start();
      EchoSocket.emit("voice:recording", { roomId: currentRoom.id, isRecording: true, status: "recording" });
    } catch (err) {
      composerFormEl.classList.remove("is-recording");
    }
  });

  sendRecordingBtn.addEventListener("click", async () => {
    // A paused recording is still a valid, stoppable recording — only
    // "nothing has been recorded at all" (fully inactive) should block send.
    if (!EchoRecorder.isRecording() && !EchoRecorder.isPaused()) return;
    const result = await EchoRecorder.stop();
    composerFormEl.classList.remove("is-recording");
    if (result && result.blob.size > 800) {
      const ext = extForMimeType(result.mimeType);
      const file = new File([result.blob], `voice-note-${Date.now()}.${ext}`, { type: result.mimeType });
      // Recording itself has stopped, but the room shouldn't just go
      // silent until the upload finishes — switch the indicator to
      // "uploading" for the duration, then clear it once uploadAndSend
      // settles (whether it succeeds or the retry UI takes over).
      EchoSocket.emit("voice:recording", { roomId: currentRoom.id, isRecording: true, status: "uploading" });
      try {
        await uploadAndSend(file);
      } finally {
        EchoSocket.emit("voice:recording", { roomId: currentRoom.id, isRecording: false });
      }
    } else {
      EchoSocket.emit("voice:recording", { roomId: currentRoom.id, isRecording: false });
    }
  });

  document.getElementById("btn-cancel-recording").addEventListener("click", () => {
    composerFormEl.classList.remove("is-recording");
    EchoSocket.emit("voice:recording", { roomId: currentRoom.id, isRecording: false });
  });

  document.getElementById("btn-pause-recording").addEventListener("click", (e) => {
    if (EchoRecorder.isPaused()) {
      EchoRecorder.resume();
      e.currentTarget.textContent = "⏸";
      e.currentTarget.title = "Pause";
    } else if (EchoRecorder.isRecording()) {
      EchoRecorder.pause();
      e.currentTarget.textContent = "▶";
      e.currentTarget.title = "Resume";
    }
  });

  /* ============================== Camera capture ============================== */

  document.getElementById("btn-camera").addEventListener("click", openCameraModal);

  function openCameraModal() {
    const backdrop = EchoModal.open("tpl-camera");
    const video = backdrop.querySelector("#cam-video");
    const canvas = backdrop.querySelector("#cam-canvas");
    const preview = backdrop.querySelector("#cam-preview");
    const videoPreview = backdrop.querySelector("#cam-video-preview");
    const shootBtn = backdrop.querySelector("#cam-shoot");
    const switchBtn = backdrop.querySelector("#cam-switch");
    const flashBtn = backdrop.querySelector("#cam-flash");
    const modePhotoBtn = backdrop.querySelector("#cam-mode-photo");
    const modeVideoBtn = backdrop.querySelector("#cam-mode-video");
    const modeHint = backdrop.querySelector("#cam-mode-hint");
    const confirmActions = backdrop.querySelector("#cam-confirm-actions");
    const retakeBtn = backdrop.querySelector("#cam-retake");
    const sendBtnEl = backdrop.querySelector("#cam-send");

    let facing = "user";
    let stream = null;
    let capturedBlob = null;
    let capturedKind = "photo"; // 'photo' | 'video'
    let mode = "photo";
    let flashOn = false;
    let mediaRecorder = null;
    let recChunks = [];
    let recTimer = null;
    let recSeconds = 0;

    async function startCam() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: mode === "video" });
        video.srcObject = stream;
        video.style.transform = facing === "user" ? "scaleX(-1)" : "none"; // mirror front camera
        flashBtn.style.display = trackSupportsTorch() ? "flex" : "none";
      } catch (err) {
        EchoToast.error("Could not access the camera.");
        EchoModal.close();
      }
    }
    startCam();

    function trackSupportsTorch() {
      const track = stream?.getVideoTracks()[0];
      const caps = track?.getCapabilities?.();
      return !!caps?.torch;
    }

    flashBtn.addEventListener("click", async () => {
      const track = stream?.getVideoTracks()[0];
      if (!track || !trackSupportsTorch()) {
        return EchoToast.info("Flash/torch isn't supported on this camera or device.");
      }
      flashOn = !flashOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: flashOn }] });
        flashBtn.classList.toggle("active", flashOn);
      } catch (err) {
        EchoToast.error("Couldn't toggle flash.");
      }
    });

    modePhotoBtn.addEventListener("click", () => setMode("photo"));
    modeVideoBtn.addEventListener("click", () => setMode("video"));
    function setMode(m) {
      mode = m;
      modeHint.textContent = m === "photo" ? "Take a photo and preview it before sending." : "Record a short video clip.";
      shootBtn.textContent = m === "photo" ? "Capture" : "Start recording";
      startCam();
    }

    switchBtn.addEventListener("click", () => { facing = facing === "user" ? "environment" : "user"; startCam(); });

    shootBtn.addEventListener("click", () => {
      if (mode === "photo") capturePhoto();
      else if (!mediaRecorder || mediaRecorder.state === "inactive") startVideoRecording();
      else stopVideoRecording();
    });

    function capturePhoto() {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (facing === "user") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(video, 0, 0);
      canvas.toBlob((blob) => {
        capturedBlob = blob;
        capturedKind = "photo";
        preview.src = URL.createObjectURL(blob);
        preview.classList.remove("hidden");
        video.classList.add("hidden");
        shootBtn.parentElement.classList.add("hidden");
        confirmActions.classList.remove("hidden");
      }, "image/jpeg", 0.92);
    }

    function startVideoRecording() {
      recChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        capturedBlob = new Blob(recChunks, { type: mediaRecorder.mimeType || "video/webm" });
        capturedKind = "video";
        videoPreview.src = URL.createObjectURL(capturedBlob);
        videoPreview.classList.remove("hidden");
        video.classList.add("hidden");
        shootBtn.parentElement.classList.add("hidden");
        confirmActions.classList.remove("hidden");
        sendBtnEl.textContent = "Send video";
        clearInterval(recTimer);
      };
      mediaRecorder.start();
      recSeconds = 0;
      shootBtn.textContent = "Stop (0:00)";
      recTimer = setInterval(() => {
        recSeconds++;
        shootBtn.textContent = `Stop (${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, "0")})`;
        if (recSeconds >= 120) stopVideoRecording(); // 2 min cap keeps this reasonable for a chat clip
      }, 1000);
    }

    function stopVideoRecording() {
      if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    }

    retakeBtn.addEventListener("click", () => {
      preview.classList.add("hidden");
      videoPreview.classList.add("hidden");
      video.classList.remove("hidden");
      confirmActions.classList.add("hidden");
      shootBtn.parentElement.classList.remove("hidden");
      shootBtn.textContent = mode === "photo" ? "Capture" : "Start recording";
      sendBtnEl.textContent = "Send photo";
      startCam();
    });

    sendBtnEl.addEventListener("click", async () => {
      if (!capturedBlob) return;
      EchoModal.close();
      const file =
        capturedKind === "photo"
          ? new File([capturedBlob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" })
          : new File([capturedBlob], `clip-${Date.now()}.webm`, { type: capturedBlob.type || "video/webm" });
      await uploadAndSend(file);
    });

    // Ensure the camera stream stops if the modal is dismissed via backdrop/Escape.
    const observer = new MutationObserver(() => {
      if (!document.body.contains(video)) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        observer.disconnect();
      }
    });
    observer.observe(document.getElementById("modal-root"), { childList: true });
  }

  /* ---- Voice note playback UI sync (delegated since <audio> elements are
     recreated on every re-render; play/pause/timeupdate don't bubble, so we
     listen in the capture phase on document instead of per-element). ---- */
  function formatAudioTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function syncVoiceNoteUI(audio) {
    const id = audio.id;
    const btn = document.querySelector(`.voice-note-play[data-audio-id="${id}"]`);
    const playIcon = btn?.querySelector(".play-icon");
    const timeEl = document.getElementById(`time-${id}`);
    const waveEl = document.getElementById(`wave-${id}`);

    if (playIcon) {
      playIcon.innerHTML = audio.paused
        ? `<path d="m3 3 18 9-18 9V3Z"/>`
        : `<rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/>`;
    }
    if (timeEl) {
      const remaining = audio.duration && !audio.paused ? audio.duration - audio.currentTime : audio.duration || 0;
      timeEl.textContent = formatAudioTime(audio.ended ? audio.duration || 0 : audio.paused ? audio.duration || 0 : remaining);
    }
    if (waveEl && audio.duration) {
      const progress = Math.min(1, audio.currentTime / audio.duration);
      const bars = waveEl.children;
      const litCount = Math.round(progress * bars.length);
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.background = i < litCount ? "var(--accent)" : "var(--text-faint)";
      }
    }
  }

  /** Chrome and Firefox report `audio.duration` as Infinity/NaN for
   * MediaRecorder-produced webm/ogg files right after loadedmetadata — a
   * live-recorded container has no total duration written into its header,
   * only its actual end does. The standard workaround: seek far past the
   * end once, read the real duration off the resulting timeupdate, then
   * seek back to the start. Without this, voice-note duration never shows
   * anything but 0:00. */
  function ensureFiniteDuration(audio, onReady) {
    if (isFinite(audio.duration) && audio.duration > 0) return onReady();
    const onTimeUpdate = () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.currentTime = 0;
      onReady();
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    try {
      audio.currentTime = 1e101;
    } catch (e) {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      onReady(); // some browsers throw on an out-of-range seek instead of just clamping — fall back gracefully
    }
  }

  ["play", "pause", "timeupdate", "ended"].forEach((evt) => {
    document.addEventListener(
      evt,
      (e) => { if (e.target.tagName === "AUDIO" && e.target.id.startsWith("vn-")) syncVoiceNoteUI(e.target); },
      true
    );
  });
  document.addEventListener(
    "loadedmetadata",
    (e) => {
      if (e.target.tagName !== "AUDIO" || !e.target.id.startsWith("vn-")) return;
      ensureFiniteDuration(e.target, () => syncVoiceNoteUI(e.target));
    },
    true
  );

  /* ============================== Read receipts ============================== */

  chatBody.addEventListener("scroll", debounce(() => {
    if (currentRoom) EchoSocket.emit("message:read", { roomId: currentRoom.id });
  }, 800));

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function onPollUpdated({ pollId, tally, totalVotes }) {
    const msg = messages.find((m) => m.poll?.id === pollId);
    if (msg) { msg.poll.tally = tally; msg.poll.totalVotes = totalVotes; renderAll(); }
  }
  function onPollClosed({ pollId }) {
    const msg = messages.find((m) => m.poll?.id === pollId);
    if (msg) { msg.poll.closed = true; renderAll(); }
  }
  function onLocationUpdated({ messageId, lat, lng }) {
    const msg = messages.find((m) => m.id === messageId);
    if (msg) {
      msg.content = JSON.stringify({ lat, lng });
      const card = document.querySelector(`[data-location-id="${messageId}"]`);
      if (card?._map) { card._map.setView([lat, lng], 15); card._marker.setLatLng([lat, lng]); }
    }
  }
  function onLocationStopped({ messageId }) {
    const msg = messages.find((m) => m.id === messageId);
    if (msg) { msg.locationLiveUntil = null; renderAll(); }
  }

  window.EchoChat = {
    setContext,
    loadInitialMessages,
    setMemberLastReadMap,
    onMessageNew,
    onMessageEdited,
    onMessageDeleted,
    onMessagePinned,
    onReaction,
    onTyping,
    onVoiceRecording,
    onSeen,
    onPollUpdated,
    onPollClosed,
    onLocationUpdated,
    onLocationStopped,
    jumpToMessage,
    resetTyping: () => { typingUsers.clear(); recordingUsers.clear(); renderTyping(); },
    getMessages: () => messages,
  };
})();
