(function () {
  "use strict";

  const callRoot = document.getElementById("call-root");
  let pc = null;
  let localStream = null;
  let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  let current = null; // { callId, roomId, peerId, peerName, callType, isCaller }
  let callTimerInterval = null;
  let callStartedAt = null;
  let pendingCandidates = [];
  let facingMode = "user";
  let ringtoneCtx = null;
  let ringtoneLoopTimer = null;
  let incomingCallOpen = false; // tracks whether the incoming-call modal (not the in-call overlay) is up
  let ringingCallId = null;
  let localLevelMeter = null;
  let remoteLevelMeter = null;
  let minimized = false;
  let autoHideCtl = null;
  let statsExtra = { bitrateKbps: 0, fps: 0, resolution: "" };
  let prevBytesReceived = null;
  let prevStatsTs = null;

  async function loadIceServers() {
    try {
      const res = await EchoAPI.get("/api/config/rtc");
      if (res.iceServers && res.iceServers.length) iceServers = res.iceServers;
    } catch (e) { /* fall back to default STUN */ }
  }

  function formatDuration(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  /* ============================== Ringtone ============================== */
  // No audio asset ships with this project, so the ringtone is synthesized
  // with Web Audio (a classic two-tone ring, looped) rather than left as
  // silent dead code. Kept as free functions (not tied to one call) so they
  // can be called from every exit path: accept, decline, timeout, and the
  // call ending out from under the still-open incoming-call modal.
  function startRingtone() {
    stopRingtone(); // never let two overlap if this is somehow called twice
    try {
      ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      return; // Web Audio unavailable — the visual modal is still the primary cue
    }

    const playRingBurst = () => {
      if (!ringtoneCtx || ringtoneCtx.state === "closed") return;
      const now = ringtoneCtx.currentTime;
      [440, 480].forEach((freq) => {
        const osc = ringtoneCtx.createOscillator();
        const gain = ringtoneCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.12;
        osc.connect(gain);
        gain.connect(ringtoneCtx.destination);
        osc.start(now);
        osc.stop(now + 1); // ~1s tone
      });
    };

    ringtoneCtx.resume().catch(() => {});
    playRingBurst();
    ringtoneLoopTimer = setInterval(playRingBurst, 3000); // ~1s on / ~2s off
  }

  function stopRingtone() {
    if (ringtoneLoopTimer) { clearInterval(ringtoneLoopTimer); ringtoneLoopTimer = null; }
    if (ringtoneCtx) { ringtoneCtx.close().catch(() => {}); ringtoneCtx = null; }
  }

  /* ============================== Incoming call ============================== */

  function wireSwipeButton(btn, onTrigger, direction) {
    // Real drag-to-trigger: works alongside a plain click/tap (accessibility —
    // dragging shouldn't be the *only* way to answer/decline a call).
    let dragging = false, startX = 0, startY = 0, moved = false;
    btn.addEventListener("pointerdown", (e) => {
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      btn.classList.add("dragging");
      btn.setPointerCapture?.(e.pointerId);
    });
    btn.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > 6) moved = true;
      const dist = direction === "up" ? Math.max(0, startY - e.clientY) : Math.abs(dx);
      btn.style.transform = direction === "up"
        ? `translateY(${-Math.min(dist, 70)}px) scale(${1 + Math.min(dist, 70) / 350})`
        : `translateX(${dx > 0 ? Math.min(dx, 70) : Math.max(dx, -70)}px)`;
      if (dist > 58) btn.classList.add("armed"); else btn.classList.remove("armed");
    });
    function finish(e) {
      if (!dragging) return;
      dragging = false;
      btn.classList.remove("dragging");
      const armed = btn.classList.contains("armed");
      btn.classList.remove("armed");
      btn.style.transform = "";
      if (armed) onTrigger();
    }
    btn.addEventListener("pointerup", finish);
    btn.addEventListener("pointercancel", finish);
    // Plain tap/click (no drag distance) also triggers — required for
    // mouse/keyboard/screen-reader users, not just touch swipers.
    btn.addEventListener("click", (e) => { if (!moved) onTrigger(); });
  }

  function showIncomingCall({ callId, roomId, callType, from }) {
    const backdrop = EchoModal.open("tpl-incoming-call");
    backdrop.classList.add("incoming-call-v2-backdrop");
    incomingCallOpen = true;
    ringingCallId = callId;
    backdrop.querySelector("#ic-avatar").textContent = (from.username || "?").slice(0, 2).toUpperCase();
    backdrop.querySelector("#ic-name").textContent = from.username;
    backdrop.querySelector("#ic-type").textContent = `Incoming ${callType} call`;
    backdrop.querySelector("#ic-sub").textContent = callType === "video" ? "Video call" : "Voice call";

    startRingtone();
    EchoCallFx.enhanceButtons(backdrop, ".ic-quick-actions button");

    function closeIncomingModal() {
      stopRingtone();
      incomingCallOpen = false;
      ringingCallId = null;
      EchoModal.close();
    }

    async function decline() {
      try {
        await EchoSocket.emitAck("call:respond", { callId, accept: false });
      } catch (err) {
        EchoToast.error(err.message || "Couldn't reach the server — closing anyway.");
      }
      closeIncomingModal();
    }

    async function accept() {
      closeIncomingModal();
      current = { callId, roomId, peerId: from.id, peerName: from.username, callType, isCaller: false };
      try {
        await EchoSocket.emitAck("call:respond", { callId, accept: true });
      } catch (err) {
        EchoToast.error(err.message || "Couldn't accept the call.");
        current = null;
        return;
      }
      renderCallOverlay();
      // Wait for the caller's offer — handled in the 'call:offer' listener below.
    }

    wireSwipeButton(backdrop.querySelector("#ic-decline"), decline, "x");
    wireSwipeButton(backdrop.querySelector("#ic-accept"), accept, "up");

    // Escape declines (rather than just visually dismissing the call while
    // it keeps ringing server-side) — the generic modal Escape handler also
    // fires and closes the (by-then-already-closed) backdrop, which is a
    // harmless no-op.
    function onEscape(e) { if (e.key === "Escape") decline(); }
    document.addEventListener("keydown", onEscape);
    const cleanupEscape = () => document.removeEventListener("keydown", onEscape);
    backdrop.querySelector("#ic-decline").addEventListener("click", cleanupEscape, { once: true });
    backdrop.querySelector("#ic-accept").addEventListener("click", cleanupEscape, { once: true });

    // "Remind me later": no push-notification/scheduling backend exists in
    // this project, so this is honestly scoped to a client-side timer —
    // it declines now and, if this tab/app is still open in 5 minutes,
    // shows a toast nudge. It intentionally does not claim to notify you
    // if the app is closed.
    backdrop.querySelector("#ic-remind").addEventListener("click", () => {
      decline();
      EchoToast.info(`Okay — we'll remind you about ${from.username}'s call in 5 minutes (if EchoLink is still open).`);
      setTimeout(() => EchoToast.info(`Reminder: you missed a call from ${from.username}.`), 5 * 60 * 1000);
    });

    backdrop.querySelector("#ic-block").addEventListener("click", async () => {
      await decline();
      try {
        await EchoAPI.post(`/api/users/${from.id}/block`, {});
        EchoToast.success(`Blocked ${from.username}.`);
      } catch (err) {
        EchoToast.error(err.message || "Couldn't block that user.");
      }
    });

    // Quick reply: a real chat message via the same message:send flow used
    // everywhere else in the app — not a special call-reply channel.
    const replyBtn = backdrop.querySelector("#ic-reply");
    const replyBox = backdrop.querySelector("#ic-reply-box");
    replyBtn.addEventListener("click", () => {
      replyBox.classList.toggle("hidden");
      if (!replyBox.classList.contains("hidden")) backdrop.querySelector("#ic-reply-input").focus();
    });
    replyBox.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = backdrop.querySelector("#ic-reply-input");
      const text = input.value.trim();
      if (!text) return;
      try {
        await EchoSocket.emitAck("message:send", { roomId, type: "text", content: text });
        EchoToast.success("Reply sent.");
        input.value = "";
        replyBox.classList.add("hidden");
      } catch (err) {
        EchoToast.error(err.message || "Couldn't send reply.");
      }
    });
  }

  /* ============================== Outgoing call ============================== */

  async function startCall(roomId, peer, callType) {
    if (current) return EchoToast.error("You're already in a call.");
    try {
      const { callId } = await EchoSocket.emitAck("call:invite", { roomId, calleeId: peer.id, callType });
      current = { callId, roomId, peerId: peer.id, peerName: peer.username, callType, isCaller: true };
      renderCallOverlay(true);
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  async function onAccepted({ callId } = {}) {
    if (!current || current.callId !== callId) return;
    await setupPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    EchoSocket.emit("call:offer", { callId: current.callId, sdpOffer: offer });
    setCallStatus("connecting", "Connecting…");
  }

  async function onOffer({ callId, sdpOffer }) {
    if (!current || current.callId !== callId) return;
    await setupPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));
    for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(() => {});
    pendingCandidates = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    EchoSocket.emit("call:answer", { callId, sdpAnswer: answer });
  }

  async function onAnswer({ callId, sdpAnswer }) {
    if (!current || current.callId !== callId || !pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
    for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(() => {});
    pendingCandidates = [];
  }

  function onDeclined({ callId } = {}) {
    if (!current || current.callId !== callId) return;
    EchoToast.info(`${current?.peerName || "They"} declined the call.`);
    teardown();
  }

  function onEnded({ callId, reason } = {}) {
    if (incomingCallOpen && ringingCallId === callId) {
      stopRingtone();
      incomingCallOpen = false;
      ringingCallId = null;
      EchoModal.close();
    }
    if (!current || current.callId !== callId) return; // not about this tab's active call — nothing further to tear down
    EchoToast.info("Call ended.");
    teardown();
  }

  /* ============================== Peer connection ============================== */

  async function setupPeerConnection() {
    pc = new RTCPeerConnection({ iceServers });

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: current.callType === "video" ? { facingMode } : false,
      });
    } catch (err) {
      EchoToast.error("Could not access camera/microphone.");
      teardown();
      throw err;
    }

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const localVideo = document.getElementById("call-video-local");
    if (localVideo) localVideo.srcObject = localStream;

    // Live mic-level meter + "speaking" ring on our own avatar (voice-only
    // view) — pure local audio analysis, nothing sent over the wire beyond
    // what call:state already relays for mute state.
    localLevelMeter?.stop();
    localLevelMeter = EchoCallFx.createAudioLevelMeter(localStream, (level) => {
      const fill = document.getElementById("call-mic-fill");
      if (fill) fill.style.width = `${Math.round(level * 100)}%`;
    });

    pc.ontrack = (event) => {
      const remoteVideo = document.getElementById("call-video-remote");
      if (remoteVideo) remoteVideo.srcObject = event.streams[0];
      document.getElementById("call-avatar-stage")?.classList.add("hidden");

      if (event.track.kind === "audio") {
        remoteLevelMeter?.stop();
        const remoteStream = new MediaStream([event.track]);
        remoteLevelMeter = EchoCallFx.createAudioLevelMeter(remoteStream, (level, freqData) => {
          document.getElementById("call-avatar-ring")?.classList.toggle("speaking", level > 0.12);
          const canvas = document.getElementById("call-waveform");
          if (canvas) EchoCallFx.drawWaveformBars(canvas, freqData, "#00D9C0");
        });
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        EchoSocket.emit("call:ice-candidate", { callId: current.callId, candidate: event.candidate, toUserId: current.peerId });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        callStartedAt = Date.now();
        setCallStatus("connected", null);
        startCallTimer();
        startQualityMonitor();
      } else if (["failed", "disconnected"].includes(pc.connectionState)) {
        setCallStatus("reconnecting", "Reconnecting…");
      }
    };
  }

  function onIceCandidate({ callId, candidate } = {}) {
    if (!candidate || !current || current.callId !== callId) return;
    const ice = new RTCIceCandidate(candidate);
    if (pc && pc.remoteDescription) pc.addIceCandidate(ice).catch(() => {});
    else pendingCandidates.push(ice);
  }

  function onCallState({ callId, state } = {}) {
    if (!current || current.callId !== callId || !state) return;
    if (state.remoteAudioMuted !== undefined) {
      document.getElementById("call-remote-muted-badge")?.classList.toggle("hidden", !state.remoteAudioMuted);
    }
    if (state.hold !== undefined) {
      document.getElementById("call-hold-banner")?.classList.toggle("hidden", !state.hold);
    }
    if (state.reaction) {
      EchoCallFx.spawnFloatingReaction(document.getElementById("call-reaction-layer"), state.reaction);
    }
  }

  /* ============================== UI ============================== */

  let callState = { micOn: true, camOn: true, screenSharing: false, hold: false, onHold: false };

  const FILTERS = [
    { id: "normal", label: "Normal", css: "none" },
    { id: "warm", label: "Warm", css: "sepia(0.35) saturate(1.3)" },
    { id: "cool", label: "Cool", css: "hue-rotate(180deg) saturate(1.2)" },
    { id: "mono", label: "B&W", css: "grayscale(1)" },
    { id: "vivid", label: "Vivid", css: "saturate(1.8) contrast(1.15)" },
    { id: "soft", label: "Soft focus", css: "blur(1px) brightness(1.08)" },
  ];

  function renderCallOverlay() {
    callState = { micOn: true, camOn: current.callType === "video", screenSharing: false, hold: false, onHold: false };
    minimized = false;
    const isVideo = current.callType === "video";

    callRoot.innerHTML = `
      <div class="call-overlay-v2 ${isVideo ? "video-mode" : "voice-mode"}" id="call-overlay-root">
        ${!isVideo ? '<div class="call-ambient-bg" aria-hidden="true"></div>' : ""}
        <div class="call-header-v2">
          <div class="call-header-left">
            <div>
              <div class="call-peer-name">${escapeHtml(current.peerName)}</div>
              <div class="call-status-line" id="call-status-line"><span class="dot"></span><span id="call-status">Calling…</span></div>
            </div>
          </div>
          <div class="call-header-badges">
            ${isVideo ? '<span class="call-chip hd hidden" id="call-hd-badge">HD</span>' : ""}
            <div class="conn-quality-v2 good" id="call-quality" title="Connection quality">
              <div class="bars"><span></span><span></span><span></span></div>
              <span id="call-quality-label">Good</span>
            </div>
            <button class="call-fab small has-tooltip" id="call-minimize" data-tooltip="Minimize" aria-label="Minimize call">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9h12M6 15h12"/></svg>
            </button>
            ${isVideo ? '<button class="call-fab small has-tooltip" id="call-pip" data-tooltip="Picture in picture" aria-label="Picture in picture"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/></svg></button>' : ""}
          </div>
        </div>

        <div class="call-stage-v2" id="call-stage">
          <video class="call-video-remote-v2 waiting" id="call-video-remote" autoplay playsinline></video>
          <video class="call-video-local-v2 ${isVideo ? "" : "hidden"}" id="call-video-local" autoplay playsinline muted></video>
          ${isVideo ? `
            <div class="call-avatar-only" id="call-avatar-stage" style="position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:16px; color:#fff;">
              <div class="call-avatar-ring" id="call-avatar-ring"><div class="avatar-fallback">${(current.peerName || "?").slice(0, 2).toUpperCase()}</div></div>
              <div>${escapeHtml(current.peerName)}</div>
            </div>
            <div class="call-hold-banner hidden" id="call-hold-banner"><div class="icon">⏸️</div><div class="title">Call on hold</div><div class="sub">${escapeHtml(current.peerName)} put the call on hold</div></div>
            <div class="call-stats-v2" id="call-stats-extra"></div>
            <div class="call-reaction-layer" id="call-reaction-layer"></div>
          ` : `
            <div class="call-avatar-wrap">
              <div class="call-avatar-ring" id="call-avatar-ring"><div class="avatar-fallback">${(current.peerName || "?").slice(0, 2).toUpperCase()}</div></div>
              <div class="call-peer-name-lg">${escapeHtml(current.peerName)}</div>
              <canvas class="call-waveform-v2" id="call-waveform" width="200" height="44"></canvas>
              <div class="mic-level-meter"><div class="fill" id="call-mic-fill"></div></div>
            </div>
            <div class="call-hold-banner hidden" id="call-hold-banner"><div class="icon">⏸️</div><div class="title">Call on hold</div><div class="sub">${escapeHtml(current.peerName)} put the call on hold</div></div>
            <div class="call-reaction-layer" id="call-reaction-layer"></div>
          `}
          <span class="badge badge-live hidden" id="call-remote-muted-badge" style="position:absolute; top:16px; left:16px; z-index:2;">Muted</span>
        </div>

        <div class="call-controls-secondary-row hidden" id="call-secondary-row"></div>
        <div class="call-controls-v2" id="call-controls-bar">
          <button class="call-fab active has-tooltip" id="call-toggle-mic" data-tooltip="Mute" aria-label="Mute microphone" aria-pressed="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg></button>
          <button class="call-fab has-tooltip" id="call-output" data-tooltip="Audio output" aria-label="Choose audio output"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button>
          <button class="call-fab has-tooltip" id="call-hold" data-tooltip="Hold" aria-label="Hold call"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg></button>
          ${isVideo ? `<button class="call-fab active has-tooltip" id="call-toggle-cam" data-tooltip="Camera" aria-label="Toggle camera" aria-pressed="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m23 7-7 5 7 5V7Z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></button>
          <button class="call-fab has-tooltip" id="call-screen-share" data-tooltip="Share screen" aria-label="Share screen"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>` : ""}
          <button class="call-fab end has-tooltip" id="call-end" data-tooltip="End call" aria-label="End call"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" transform="rotate(135 12 12)"/></svg></button>
          ${isVideo ? `<button class="call-fab has-tooltip" id="call-switch-cam" data-tooltip="Switch camera" aria-label="Switch camera"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
          <button class="call-fab has-tooltip" id="call-filters" data-tooltip="Filters" aria-label="Video filters"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2a10 10 0 1 0 0 20 3 3 0 0 0 3-3c0-1-1-1.5-1-2.5A2.5 2.5 0 0 1 16.5 14H19a3 3 0 0 0 3-3 10 10 0 0 0-10-9Z"/></svg></button>
          <button class="call-fab has-tooltip" id="call-torch" data-tooltip="Torch" aria-label="Toggle torch" style="display:none;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M15 2H9l-1 8h8l-1-8Z"/><path d="M8 10s-2 3-2 6a6 6 0 0 0 12 0c0-3-2-6-2-6"/></svg></button>
          <button class="call-fab has-tooltip" id="call-reactions" data-tooltip="Reactions" aria-label="Send a reaction">😊</button>` : ""}
          <button class="call-fab has-tooltip" id="call-add-participant" data-tooltip="Add participant" aria-label="Add participant"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg></button>
        </div>
      </div>
    `;

    const overlayRoot = document.getElementById("call-overlay-root");
    EchoCallFx.enhanceButtons(overlayRoot);

    document.getElementById("call-toggle-mic").addEventListener("click", toggleMic);
    document.getElementById("call-toggle-cam")?.addEventListener("click", toggleCam);
    document.getElementById("call-switch-cam")?.addEventListener("click", switchCamera);
    document.getElementById("call-screen-share")?.addEventListener("click", toggleScreenShare);
    document.getElementById("call-end").addEventListener("click", endCall);
    document.getElementById("call-pip")?.addEventListener("click", togglePip);
    document.getElementById("call-minimize").addEventListener("click", toggleMinimize);
    document.getElementById("call-hold").addEventListener("click", toggleHold);
    document.getElementById("call-output").addEventListener("click", openOutputPicker);
    document.getElementById("call-add-participant").addEventListener("click", openAddParticipant);
    document.getElementById("call-reactions")?.addEventListener("click", openReactionBar);
    document.getElementById("call-filters")?.addEventListener("click", openFilterStrip);
    setupTorchButton();

    const remoteVideoEl = document.getElementById("call-video-remote");
    if (remoteVideoEl) {
      remoteVideoEl.addEventListener("loadedmetadata", () => {
        remoteVideoEl.classList.remove("waiting");
        document.getElementById("call-hd-badge")?.classList.toggle("hidden", remoteVideoEl.videoHeight < 720);
      });
    }

    if (isVideo) {
      EchoCallFx.makeDraggableResizable(document.getElementById("call-video-local"));
      autoHideCtl = EchoCallFx.initAutoHideControls(
        document.getElementById("call-stage"),
        document.getElementById("call-controls-bar")
      );
    }

    if (current.isCaller) setCallStatus("ringing", "Ringing…");
  }

  /* ---- Minimize to a floating pill (the "Chat" affordance — see button below) ---- */

  function toggleMinimize() {
    const overlay = document.getElementById("call-overlay-root");
    if (!overlay) return;
    minimized = !minimized;
    overlay.classList.toggle("minimized-pill", minimized);
    if (minimized) {
      EchoToast.info("Call minimized — tap the bar to return.");
      overlay.style.cssText = "position:fixed; left:50%; top:max(10px, env(safe-area-inset-top)); transform:translateX(-50%); width:min(320px, calc(100vw - 24px)); height:56px; border-radius:999px; z-index:1800; overflow:hidden; cursor:pointer; box-shadow:0 8px 24px rgba(0,0,0,0.5);";
      overlay.addEventListener("click", restoreFromMinimized, { once: true });
    } else {
      overlay.removeAttribute("style");
    }
  }
  function restoreFromMinimized() {
    minimized = false;
    const overlay = document.getElementById("call-overlay-root");
    overlay?.classList.remove("minimized-pill");
    overlay?.removeAttribute("style");
  }

  /* ---- Hold (reuses the existing generic call:state relay — no new
     server-side event, the handler already forwards any state object) ---- */

  function toggleHold() {
    callState.onHold = !callState.onHold;
    localStream?.getTracks().forEach((t) => (t.enabled = !callState.onHold && (t.kind === "audio" ? callState.micOn : callState.camOn)));
    document.getElementById("call-hold")?.classList.toggle("active", callState.onHold);
    EchoSocket.emit("call:state", { callId: current.callId, toUserId: current.peerId, state: { hold: callState.onHold } });
    EchoToast.info(callState.onHold ? "Call on hold." : "Call resumed.");
  }

  /* ---- Reactions (same relay channel) ---- */

  function openReactionBar() {
    document.querySelector(".call-reaction-bar")?.remove();
    const bar = document.createElement("div");
    bar.className = "call-reaction-bar";
    ["❤️", "👍", "😂", "👏", "🔥"].forEach((emoji) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = emoji;
      btn.setAttribute("aria-label", `Send ${emoji} reaction`);
      btn.addEventListener("click", () => {
        EchoCallFx.spawnFloatingReaction(document.getElementById("call-reaction-layer"), emoji);
        EchoSocket.emit("call:state", { callId: current.callId, toUserId: current.peerId, state: { reaction: emoji } });
        bar.remove();
      });
      bar.appendChild(btn);
    });
    document.getElementById("call-stage").appendChild(bar);
    setTimeout(() => { document.addEventListener("pointerdown", closeBarOnce); }, 0);
    function closeBarOnce(e) {
      if (!bar.contains(e.target)) { bar.remove(); document.removeEventListener("pointerdown", closeBarOnce); }
    }
  }

  /* ---- Audio output picker (Speaker / Bluetooth — one unified device list) ---- */

  async function openOutputPicker() {
    const mediaEl = document.getElementById("call-video-remote");
    if (!EchoCallFx.supportsOutputSelection(mediaEl)) {
      return EchoToast.info("This browser doesn't support choosing an audio output device (Chrome/Edge only). Use your device's system audio settings instead.");
    }
    const outputs = await EchoCallFx.listAudioOutputs();
    if (outputs.length === 0) return EchoToast.info("No selectable audio output devices were found.");
    EchoContextMenu.open(
      window.innerWidth / 2,
      window.innerHeight - 220,
      outputs.map((d) => ({
        label: d.label || "Audio device",
        onClick: async () => {
          try {
            await mediaEl.setSinkId(d.deviceId);
            EchoToast.success(`Audio routed to ${d.label || "selected device"}.`);
          } catch (err) {
            EchoToast.error("Couldn't switch audio output.");
          }
        },
      }))
    );
  }

  /* ---- Add participant: reuses the existing group-call infrastructure
     as-is (ends this 1:1 call, opens the existing member picker, which
     already starts a real group call) rather than any new "upgrade a live
     call" server feature. ---- */

  async function openAddParticipant() {
    if (!current) return;
    const roomId = current.roomId, callType = current.callType;
    try {
      const { members } = await EchoAPI.get(`/api/rooms/${roomId}/members`);
      const others = members.filter((m) => m.id !== window.EchoApp.getMe().id);
      endCall();
      EchoToast.info("Starting a group call so you can add more people…");
      window.EchoGroupCall.openMemberPicker(roomId, callType, others);
    } catch (err) {
      EchoToast.error("Couldn't load room members.");
    }
  }

  /* ---- Torch (real capability, only shown where the browser/hardware
     actually reports support) ---- */

  function setupTorchButton() {
    const btn = document.getElementById("call-torch");
    if (!btn) return;
    const track = localStream?.getVideoTracks?.()[0];
    const caps = track?.getCapabilities?.();
    if (!caps || !caps.torch) return; // stays display:none — not supported here
    btn.style.display = "";
    let on = false;
    btn.addEventListener("click", async () => {
      try {
        await track.applyConstraints({ advanced: [{ torch: !on }] });
        on = !on;
        btn.classList.toggle("active", on);
      } catch (err) {
        EchoToast.error("Couldn't toggle torch.");
      }
    });
  }

  /* ---- Filters: real canvas-based color grading applied to the outgoing
     video track (not a mock — the peer actually receives the filtered
     video). True ML background segmentation/virtual backgrounds are out
     of scope; "Soft focus" here is a plain blur+brightness look, not
     person-aware background blur. ---- */

  let filterCanvas = null, filterCtx = null, filterRaf = null;

  function openFilterStrip() {
    document.querySelector(".call-filters-strip")?.remove();
    const strip = document.createElement("div");
    strip.className = "call-filters-strip";
    FILTERS.forEach((f) => {
      const chip = document.createElement("div");
      chip.className = `call-filter-chip${callState.activeFilter === f.id || (!callState.activeFilter && f.id === "normal") ? " active" : ""}`;
      chip.innerHTML = `<div class="swatch f-${f.id}"></div><span>${f.label}</span>`;
      chip.addEventListener("click", () => { applyFilter(f); strip.querySelectorAll(".call-filter-chip").forEach((c) => c.classList.remove("active")); chip.classList.add("active"); });
      strip.appendChild(chip);
    });
    document.getElementById("call-stage").appendChild(strip);
    setTimeout(() => document.addEventListener("pointerdown", closeOnce), 0);
    function closeOnce(e) { if (!strip.contains(e.target)) { strip.remove(); document.removeEventListener("pointerdown", closeOnce); } }
  }

  async function applyFilter(filter) {
    callState.activeFilter = filter.id;
    const camTrack = localStream?.getVideoTracks?.()[0];
    if (!camTrack) return;

    stopFilterPipeline();
    if (filter.id === "normal") {
      const sender = pc?.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender && camTrack) await sender.replaceTrack(camTrack).catch(() => {});
      document.getElementById("call-video-local").srcObject = localStream;
      return;
    }

    // Draw each frame through a filtered canvas, then send *that* stream —
    // this genuinely changes what the peer receives, not just our own preview.
    const videoEl = document.createElement("video");
    videoEl.srcObject = new MediaStream([camTrack]);
    videoEl.muted = true;
    await videoEl.play().catch(() => {});
    filterCanvas = document.createElement("canvas");
    filterCanvas.width = camTrack.getSettings().width || 640;
    filterCanvas.height = camTrack.getSettings().height || 480;
    filterCtx = filterCanvas.getContext("2d");

    const draw = () => {
      if (!filterCtx) return;
      filterCtx.filter = filter.css;
      filterCtx.drawImage(videoEl, 0, 0, filterCanvas.width, filterCanvas.height);
      filterRaf = requestAnimationFrame(draw);
    };
    draw();

    const filteredStream = filterCanvas.captureStream(30);
    const filteredTrack = filteredStream.getVideoTracks()[0];
    const sender = pc?.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) await sender.replaceTrack(filteredTrack).catch(() => {});
    document.getElementById("call-video-local").srcObject = filteredStream;
  }

  function stopFilterPipeline() {
    if (filterRaf) cancelAnimationFrame(filterRaf);
    filterRaf = null; filterCanvas = null; filterCtx = null;
  }

  async function togglePip() {
    const remoteVideo = document.getElementById("call-video-remote");
    if (!remoteVideo || !document.pictureInPictureEnabled) {
      return EchoToast.error("Picture-in-picture isn't supported in this browser.");
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (remoteVideo.srcObject) {
        await remoteVideo.requestPictureInPicture();
      } else {
        EchoToast.info("Picture-in-picture is available once the other side's video connects.");
      }
    } catch (err) {
      EchoToast.error("Couldn't enter picture-in-picture.");
    }
  }

  let qualityTimer = null;
  function startQualityMonitor() {
    stopQualityMonitor();
    qualityTimer = setInterval(async () => {
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let packetsLost = 0, packetsReceived = 0, rtt = 0, bytesReceived = 0, framesPerSecond = 0, frameWidth = 0, frameHeight = 0;
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && !report.isRemote) {
            packetsLost += report.packetsLost || 0;
            packetsReceived += report.packetsReceived || 0;
            bytesReceived += report.bytesReceived || 0;
            if (report.framesPerSecond) framesPerSecond = report.framesPerSecond;
            if (report.frameWidth) { frameWidth = report.frameWidth; frameHeight = report.frameHeight; }
          }
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime) {
            rtt = report.currentRoundTripTime;
          }
        });

        const now = Date.now();
        if (prevBytesReceived !== null && prevStatsTs) {
          const deltaBytes = bytesReceived - prevBytesReceived;
          const deltaSec = (now - prevStatsTs) / 1000;
          if (deltaSec > 0) statsExtra.bitrateKbps = Math.max(0, Math.round((deltaBytes * 8) / deltaSec / 1000));
        }
        prevBytesReceived = bytesReceived;
        prevStatsTs = now;
        statsExtra.fps = Math.round(framesPerSecond);
        statsExtra.resolution = frameWidth ? `${frameWidth}x${frameHeight}` : "";

        const lossRatio = packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
        let quality = "excellent", label = "Excellent";
        if (lossRatio > 0.08 || rtt > 0.3) { quality = "poor"; label = "Poor"; }
        else if (lossRatio > 0.02 || rtt > 0.12) { quality = "good"; label = "Good"; }
        const el = document.getElementById("call-quality");
        if (el) el.className = `conn-quality-v2 ${quality}`;
        const labelEl = document.getElementById("call-quality-label");
        if (labelEl) labelEl.textContent = label;

        const statsEl = document.getElementById("call-stats-extra");
        if (statsEl && current?.callType === "video") {
          statsEl.innerHTML = `
            <span>${statsExtra.bitrateKbps} kbps</span>
            <span>${statsExtra.fps} fps</span>
            ${statsExtra.resolution ? `<span>${statsExtra.resolution}</span>` : ""}
          `;
          document.getElementById("call-hd-badge")?.classList.toggle("hidden", frameHeight < 720);
        }
      } catch (e) { /* stats not available yet — non-fatal */ }
    }, 2000);
  }
  function stopQualityMonitor() {
    if (qualityTimer) clearInterval(qualityTimer);
    qualityTimer = null;
    prevBytesReceived = null;
    prevStatsTs = null;
  }

  function setCallStatus(kind, text) {
    const el = document.getElementById("call-status");
    const line = document.getElementById("call-status-line");
    if (!el) return;
    if (text) el.textContent = text;
    if (line && kind) line.className = `call-status-line ${kind === "connected" ? "connected" : kind === "reconnecting" ? "reconnecting" : ""}`;
  }

  function startCallTimer() {
    clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
      const el = document.getElementById("call-status");
      if (el && callStartedAt) el.textContent = formatDuration((Date.now() - callStartedAt) / 1000);
    }, 1000);
  }

  function toggleMic() {
    callState.micOn = !callState.micOn;
    localStream?.getAudioTracks().forEach((t) => (t.enabled = callState.micOn && !callState.onHold));
    const btn = document.getElementById("call-toggle-mic");
    btn?.classList.toggle("active", callState.micOn);
    btn?.setAttribute("aria-pressed", String(!callState.micOn));
    EchoSocket.emit("call:state", { callId: current.callId, toUserId: current.peerId, state: { remoteAudioMuted: !callState.micOn } });
  }

  function toggleCam() {
    callState.camOn = !callState.camOn;
    localStream?.getVideoTracks().forEach((t) => (t.enabled = callState.camOn && !callState.onHold));
    const btn = document.getElementById("call-toggle-cam");
    btn?.classList.toggle("active", callState.camOn);
    btn?.setAttribute("aria-pressed", String(callState.camOn));
  }

  async function switchCamera() {
    facingMode = facingMode === "user" ? "environment" : "user";
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
      const newTrack = newStream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
      localStream.getVideoTracks().forEach((t) => t.stop());
      localStream.removeTrack(localStream.getVideoTracks()[0]);
      localStream.addTrack(newTrack);
      document.getElementById("call-video-local").srcObject = localStream;
      setupTorchButton();
    } catch (err) {
      EchoToast.error("Couldn't switch camera.");
    }
  }

  async function toggleScreenShare() {
    const btn = document.getElementById("call-screen-share");
    if (!callState.screenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) await sender.replaceTrack(screenTrack);
        document.getElementById("call-video-local").srcObject = screenStream;
        screenTrack.onended = () => stopScreenShare();
        callState.screenSharing = true;
        btn.classList.add("active");
      } catch (err) { /* user cancelled the share picker */ }
    } else {
      stopScreenShare();
    }
  }

  async function stopScreenShare() {
    if (!localStream) return;
    const camTrack = localStream.getVideoTracks()[0];
    const sender = pc?.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender && camTrack) await sender.replaceTrack(camTrack);
    document.getElementById("call-video-local").srcObject = localStream;
    callState.screenSharing = false;
    document.getElementById("call-screen-share")?.classList.remove("active");
  }

  function endCall() {
    if (current) EchoSocket.emit("call:end", { callId: current.callId });
    teardown();
  }

  function teardown() {
    stopRingtone();
    clearInterval(callTimerInterval);
    stopQualityMonitor();
    stopFilterPipeline();
    localLevelMeter?.stop(); localLevelMeter = null;
    remoteLevelMeter?.stop(); remoteLevelMeter = null;
    autoHideCtl?.stop(); autoHideCtl = null;
    callStartedAt = null;
    minimized = false;
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (pc) pc.close();
    pc = null;
    localStream = null;
    current = null;
    pendingCandidates = [];

    const overlay = document.getElementById("call-overlay-root");
    if (overlay) {
      overlay.classList.add("ending");
      setTimeout(() => { callRoot.innerHTML = ""; }, 260);
    } else {
      callRoot.innerHTML = "";
    }
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s || "";
    return div.innerHTML;
  }

  /* ============================== Wire socket events ============================== */

  function initCallListeners() {
    EchoSocket.on("call:incoming", showIncomingCall);
    EchoSocket.on("call:accepted", onAccepted);
    EchoSocket.on("call:offer", onOffer);
    EchoSocket.on("call:answer", onAnswer);
    EchoSocket.on("call:declined", onDeclined);
    EchoSocket.on("call:ended", onEnded);
    EchoSocket.on("call:ice-candidate", onIceCandidate);
    EchoSocket.on("call:state", onCallState);
  }

  loadIceServers();

  window.EchoCall = { init: initCallListeners, start: startCall };
})();
