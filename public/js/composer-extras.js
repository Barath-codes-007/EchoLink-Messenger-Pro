(function () {
  "use strict";

  const composerInput = document.getElementById("composer-input");
  const pickerSlot = document.getElementById("picker-popover-slot");
  const mentionSlot = document.getElementById("mention-autocomplete-slot");

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s || "";
    return div.innerHTML;
  }
  function activeRoomId() {
    return window.EchoApp.getActiveRoomId();
  }

  /* ============================== Emoji / GIF / Sticker picker ============================== */

  const EMOJI_LIST = [
    ["😀", "grinning smile happy"], ["😂", "joy laugh crying funny"], ["🥹", "holding back tears touched"],
    ["😍", "heart eyes love"], ["🥰", "smiling hearts love"], ["😘", "kiss"], ["😎", "cool sunglasses"],
    ["🤔", "thinking"], ["😅", "sweat relief nervous laugh"], ["😭", "sobbing crying"], ["😡", "angry mad"],
    ["😱", "scream shock surprised"], ["🥳", "party celebrate"], ["😴", "sleepy tired"], ["🤯", "mind blown shocked"],
    ["🙃", "upside down"], ["😇", "angel innocent"], ["🤗", "hug"], ["😬", "grimace awkward"], ["🙄", "eye roll"],
    ["👍", "thumbs up like yes"], ["👎", "thumbs down dislike no"], ["👏", "clap applause"], ["🙌", "praise hooray"],
    ["🙏", "pray please thanks"], ["👋", "wave hello bye"], ["✌️", "peace victory"], ["🤝", "handshake deal"],
    ["💪", "muscle strong"], ["🤞", "fingers crossed luck"], ["👌", "ok perfect"], ["🖐️", "hand stop"],
    ["❤️", "heart love red"], ["🔥", "fire lit hot"], ["✨", "sparkles magic"], ["🎉", "party confetti celebrate"],
    ["💯", "hundred perfect score"], ["⭐", "star favorite"], ["💔", "broken heart sad"], ["😢", "sad tear"],
    ["🎂", "cake birthday"], ["🎁", "gift present"], ["🏆", "trophy win award"], ["⚡", "lightning fast"],
    ["✅", "check done yes"], ["❌", "cross no wrong"], ["❓", "question"], ["❗", "exclamation important"],
    ["💡", "idea lightbulb"], ["📌", "pin"], ["📎", "paperclip attach"], ["🔔", "bell notification"],
    ["🍕", "pizza food"], ["☕", "coffee"], ["🍺", "beer drink"], ["🎮", "game controller"], ["📱", "phone"],
    ["💻", "laptop computer"], ["🚀", "rocket launch fast"], ["🌟", "glowing star"], ["🌈", "rainbow"],
    ["☀️", "sun sunny"], ["🌧️", "rain"], ["❄️", "snow cold"], ["🐶", "dog puppy"], ["🐱", "cat kitten"],
    ["🦄", "unicorn"], ["🐸", "frog"], ["🎵", "music note"], ["📷", "camera photo"], ["🕐", "clock time"],
  ];

  const STICKER_LIST = ["🎉", "❤️", "😂", "👍", "🔥", "😍", "😭", "🙌", "😎", "💯", "🥳", "😱", "👏", "🤝", "🎂", "🚀"];

  let pickerOpen = false;

  function closePicker() {
    pickerSlot.innerHTML = "";
    pickerOpen = false;
  }

  function openPicker() {
    if (pickerOpen) return closePicker();
    pickerOpen = true;
    pickerSlot.innerHTML = `
      <div class="picker-popover glass">
        <div class="picker-tabs">
          <div class="picker-tab active" data-ptab="emoji">Emoji</div>
          <div class="picker-tab" data-ptab="gif">GIFs</div>
          <div class="picker-tab" data-ptab="sticker">Stickers</div>
        </div>
        <div class="picker-search hidden" id="picker-search-wrap"><input class="input" id="picker-search-input" placeholder="Search…" /></div>
        <div class="picker-body" id="picker-body"></div>
      </div>`;

    const tabs = pickerSlot.querySelectorAll(".picker-tab");
    tabs.forEach((t) => t.addEventListener("click", () => showPickerTab(t.dataset.ptab)));
    showPickerTab("emoji");

    setTimeout(() => document.addEventListener("mousedown", outsideClick), 0);
    function outsideClick(e) {
      if (!pickerSlot.contains(e.target) && e.target.id !== "btn-emoji") {
        document.removeEventListener("mousedown", outsideClick);
        closePicker();
      }
    }
  }

  function showPickerTab(tab) {
    pickerSlot.querySelectorAll(".picker-tab").forEach((t) => t.classList.toggle("active", t.dataset.ptab === tab));
    const body = document.getElementById("picker-body");
    const searchWrap = document.getElementById("picker-search-wrap");

    if (tab === "emoji") {
      searchWrap.classList.remove("hidden");
      renderEmojiGrid(body, "");
      document.getElementById("picker-search-input").oninput = (e) => renderEmojiGrid(body, e.target.value);
    } else if (tab === "sticker") {
      searchWrap.classList.add("hidden");
      body.innerHTML = `<div class="sticker-grid">${STICKER_LIST.map((s) => `<button type="button" data-sticker="${s}">${s}</button>`).join("")}</div>`;
      body.querySelectorAll("[data-sticker]").forEach((btn) => {
        btn.addEventListener("click", () => { sendSticker(btn.dataset.sticker); closePicker(); });
      });
    } else if (tab === "gif") {
      searchWrap.classList.remove("hidden");
      loadGifs(body, "trending");
      document.getElementById("picker-search-input").oninput = debounce((e) => loadGifs(body, e.target.value || "trending"), 400);
    }
  }

  function renderEmojiGrid(body, query) {
    const q = query.trim().toLowerCase();
    const filtered = q ? EMOJI_LIST.filter(([, keywords]) => keywords.includes(q)) : EMOJI_LIST;
    body.innerHTML = `<div class="emoji-grid">${(filtered.length ? filtered : EMOJI_LIST).map(([e]) => `<button type="button" data-emoji="${e}">${e}</button>`).join("")}</div>`;
    body.querySelectorAll("[data-emoji]").forEach((btn) => {
      btn.addEventListener("click", () => insertAtCursor(composerInput, btn.dataset.emoji));
    });
  }

  async function loadGifs(body, query) {
    body.innerHTML = `<div class="skeleton" style="height:120px;"></div>`;
    try {
      const res = await EchoAPI.get(`/api/gifs/search?q=${encodeURIComponent(query)}`);
      if (!res.gifs || res.gifs.length === 0) {
        body.innerHTML = `<p class="text-muted" style="font-size:12.5px; text-align:center; padding:20px;">No GIFs found.</p>`;
        return;
      }
      body.innerHTML = `<div class="gif-grid">${res.gifs.map((g) => `<img src="${g.previewUrl}" data-gif-url="${g.url}" loading="lazy" alt="GIF" />`).join("")}</div>`;
      body.querySelectorAll("[data-gif-url]").forEach((img) => {
        img.addEventListener("click", () => { sendGif(img.dataset.gifUrl); closePicker(); });
      });
    } catch (err) {
      body.innerHTML = `<div class="gif-unconfigured">${escapeHtml(err.message)}</div>`;
    }
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + text.length;
    input.dispatchEvent(new Event("input"));
  }

  async function sendSticker(emoji) {
    const roomId = activeRoomId();
    if (!roomId) return;
    try {
      await EchoSocket.emitAck("message:send", { roomId, type: "text", content: emoji });
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  async function sendGif(url) {
    const roomId = activeRoomId();
    if (!roomId) return;
    try {
      await EchoSocket.emitAck("message:send", { roomId, type: "gif", content: url });
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  document.getElementById("btn-emoji").addEventListener("click", openPicker);

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ============================== Mentions autocomplete ============================== */

  let mentionActive = false;

  composerInput.addEventListener("input", () => {
    const cursorPos = composerInput.selectionStart;
    const textBefore = composerInput.value.slice(0, cursorPos);
    const match = /@([a-zA-Z0-9_.]{0,20})$/.exec(textBefore);

    if (!match) return closeMentionAutocomplete();

    const members = (window.EchoApp.getActiveRoomMembers() || []).filter((m) => m.id !== window.EchoApp.getMe()?.id);
    const query = match[1].toLowerCase();
    const filtered = members.filter((m) => m.username.toLowerCase().startsWith(query)).slice(0, 6);

    if (filtered.length === 0) return closeMentionAutocomplete();
    renderMentionAutocomplete(filtered, match.index);
  });

  function renderMentionAutocomplete(members, atIndex) {
    mentionActive = true;
    mentionSlot.innerHTML = `<div class="mention-autocomplete glass">${members
      .map((m, i) => `<div class="mention-item ${i === 0 ? "active" : ""}" data-username="${escapeHtml(m.username)}"><div class="avatar-fallback" style="width:22px;height:22px;font-size:9px;">${m.username.slice(0, 2).toUpperCase()}</div>${escapeHtml(m.username)}</div>`)
      .join("")}</div>`;

    mentionSlot.querySelectorAll(".mention-item").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyMention(item.dataset.username, atIndex);
      });
    });
  }

  function applyMention(username, atIndex) {
    const cursorPos = composerInput.selectionStart;
    const before = composerInput.value.slice(0, atIndex);
    const after = composerInput.value.slice(cursorPos);
    composerInput.value = `${before}@${username} ${after}`;
    const newPos = before.length + username.length + 2;
    composerInput.focus();
    composerInput.selectionStart = composerInput.selectionEnd = newPos;
    closeMentionAutocomplete();
    composerInput.dispatchEvent(new Event("input"));
  }

  function closeMentionAutocomplete() {
    mentionActive = false;
    mentionSlot.innerHTML = "";
  }

  composerInput.addEventListener("keydown", (e) => {
    if (!mentionActive) return;
    const items = [...mentionSlot.querySelectorAll(".mention-item")];
    if (items.length === 0) return;
    let idx = items.findIndex((i) => i.classList.contains("active"));

    if (e.key === "ArrowDown") { e.preventDefault(); items[idx]?.classList.remove("active"); idx = (idx + 1) % items.length; items[idx].classList.add("active"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[idx]?.classList.remove("active"); idx = (idx - 1 + items.length) % items.length; items[idx].classList.add("active"); }
    else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const active = items[idx] || items[0];
      const match = /@([a-zA-Z0-9_.]{0,20})$/.exec(composerInput.value.slice(0, composerInput.selectionStart));
      if (match) applyMention(active.dataset.username, match.index);
    } else if (e.key === "Escape") {
      closeMentionAutocomplete();
    }
  });

  /* ============================== More tools menu (poll / schedule / location) ============================== */

  document.getElementById("btn-more-tools").addEventListener("click", (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = [
      { label: "📊 Create poll", onClick: openPollModal },
      { label: "⏰ Schedule message", onClick: openScheduleModal },
      { label: "📍 Share location", onClick: openLocationModal },
    ];
    if (["owner", "admin"].includes(window.EchoApp.getMyRole())) {
      items.push({ label: "📣 Post announcement", onClick: openAnnouncementModal });
    }
    EchoContextMenu.open(rect.left, rect.top - (items.length * 36 + 10), items);
  });

  function openAnnouncementModal() {
    const roomId = activeRoomId();
    if (!roomId) return;
    const backdrop = EchoModal.open("tpl-announcement");
    backdrop.querySelector("#announcement-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const content = backdrop.querySelector("#announcement-content").value.trim();
      if (!content) return;
      try {
        await EchoSocket.emitAck("message:send", { roomId, type: "announcement", content });
        EchoModal.close();
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  function openPollModal() {
    const roomId = activeRoomId();
    if (!roomId) return;
    const backdrop = EchoModal.open("tpl-create-poll");
    const optionsList = backdrop.querySelector("#poll-options-list");

    backdrop.querySelector("#poll-add-option").addEventListener("click", () => {
      if (optionsList.children.length >= 10) return EchoToast.error("Maximum 10 options.");
      const input = document.createElement("input");
      input.className = "input";
      input.maxLength = 80;
      input.placeholder = `Option ${optionsList.children.length + 1}`;
      input.dataset.pollOpt = "";
      optionsList.appendChild(input);
    });

    backdrop.querySelector("#poll-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const question = backdrop.querySelector("#poll-question").value.trim();
      const options = [...optionsList.querySelectorAll("[data-poll-opt]")].map((i) => i.value.trim()).filter(Boolean);
      const allowMultiple = backdrop.querySelector("#poll-allow-multiple").checked;
      try {
        await EchoSocket.emitAck("poll:create", { roomId, question, options, allowMultiple });
        EchoModal.close();
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  async function openScheduleModal() {
    const roomId = activeRoomId();
    if (!roomId) return;
    const backdrop = EchoModal.open("tpl-schedule-message");
    const minDate = new Date(Date.now() + 60000).toISOString().slice(0, 16);
    backdrop.querySelector("#schedule-when").min = minDate;

    async function refreshList() {
      const list = backdrop.querySelector("#schedule-existing-list");
      try {
        const { scheduled } = await EchoAPI.get(`/api/scheduled-messages/room/${roomId}`);
        list.innerHTML = scheduled.length
          ? `<hr style="border:none;border-top:1px solid var(--border);"/><div class="text-muted" style="font-size:12px; margin-bottom:4px;">Pending:</div>` +
            scheduled.map((s) => `<div style="display:flex; justify-content:space-between; align-items:center; font-size:12.5px; padding:6px 0;"><span>${escapeHtml(s.content.slice(0, 40))} — ${new Date(s.sendAt).toLocaleString()}</span><button type="button" class="btn-icon" data-cancel-sched="${s.id}" style="width:24px;height:24px;">&times;</button></div>`).join("")
          : "";
        list.querySelectorAll("[data-cancel-sched]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await EchoAPI.del(`/api/scheduled-messages/${btn.dataset.cancelSched}`);
            refreshList();
          });
        });
      } catch (e) { /* non-critical */ }
    }
    refreshList();

    backdrop.querySelector("#schedule-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const content = backdrop.querySelector("#schedule-content").value.trim();
      const when = backdrop.querySelector("#schedule-when").value;
      if (!when) return;
      const sendAt = new Date(when).getTime();
      try {
        await EchoAPI.post("/api/scheduled-messages", { roomId, content, sendAt });
        EchoToast.success("Message scheduled.");
        backdrop.querySelector("#schedule-content").value = "";
        refreshList();
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  /* ============================== Live location ============================== */

  let locationWatchTimer = null;

  function openLocationModal() {
    const roomId = activeRoomId();
    if (!roomId) return;
    const backdrop = EchoModal.open("tpl-location-share");
    const statusEl = backdrop.querySelector("#loc-status");
    const sendBtn = backdrop.querySelector("#loc-send");
    let coords = null;

    if (!navigator.geolocation) {
      statusEl.textContent = "Geolocation isn't supported in this browser.";
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        statusEl.textContent = "Location ready to share.";
        sendBtn.disabled = false;
      },
      () => { statusEl.textContent = "Couldn't get your location — check permissions."; },
      { enableHighAccuracy: true, timeout: 10000 }
    );

    sendBtn.addEventListener("click", async () => {
      if (!coords) return;
      const liveMinutes = parseInt(backdrop.querySelector("#loc-duration").value, 10);
      try {
        const ack = await EchoSocket.emitAck("location:share", { roomId, ...coords, liveMinutes });
        EchoModal.close();
        if (liveMinutes > 0) startLiveLocationUpdates(roomId, ack.message.id, liveMinutes);
      } catch (err) {
        EchoToast.error(err.message);
      }
    });
  }

  function startLiveLocationUpdates(roomId, messageId, liveMinutes) {
    if (locationWatchTimer) clearInterval(locationWatchTimer);
    const endAt = Date.now() + liveMinutes * 60000;
    locationWatchTimer = setInterval(() => {
      if (Date.now() > endAt) { clearInterval(locationWatchTimer); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        EchoSocket.emit("location:update", { roomId, messageId, lat: pos.coords.latitude, lng: pos.coords.longitude });
      });
    }, 20000);
  }

  window.EchoComposerExtras = { insertAtCursor };
})();
