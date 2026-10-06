(function () {
  "use strict";

  const callRoot = document.getElementById("call-root");
  let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  // Mesh state: one RTCPeerConnection per remote participant.
  let state = null; // { groupCallId, roomId, callType, hostId, isHost, localStream, peers: Map<userId, {pc, stream, username, avatarUrl, micOn, camOn}> }

  async function loadIceServers() {
    try {
      const res = await EchoAPI.get("/api/config/rtc");
      if (res.iceServers?.length) iceServers = res.iceServers;
    } catch (e) { /* fall back to default STUN */ }
  }
  loadIceServers();

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s || "";
    return div.innerHTML;
  }
  function initials(name) { return (name || "?").trim().slice(0, 2).toUpperCase(); }

  /* ============================== Starting / receiving calls ============================== */

  function showIncomingGroupCall({ groupCallId, roomId, callType, host }) {
    if (state) return; // already in a call — silently ignore concurrent invites for v1
    const backdrop = EchoModal.open("tpl-group-call-incoming");
    backdrop.classList.add("incoming-call-v2-backdrop");
    backdrop.querySelector("#gci-avatar").textContent = initials(host.username);
    backdrop.querySelector("#gci-name").textContent = host.username;
    backdrop.querySelector("#gci-type").textContent = `Starting a group ${callType} call…`;
    EchoCallFx.enhanceButtons(backdrop, ".ic-swipe-btn");

    backdrop.querySelector("#gci-decline").addEventListener("click", () => {
      EchoSocket.emit("group-call:decline", { groupCallId });
      EchoModal.close();
    });
    backdrop.querySelector("#gci-accept").addEventListener("click", async () => {
      EchoModal.close();
      await joinGroupCall(groupCallId, roomId, callType, false);
    });
  }

  async function startGroupCall(roomId, callType, memberIds) {
    if (state) return EchoToast.error("You're already in a call.");
    try {
      const ack = await EchoSocket.emitAck("group-call:start", { roomId, callType, memberIds });
      await joinGroupCall(ack.groupCallId, roomId, callType, true);
      if (ack.invited === 0) EchoToast.info("No one else is online in this room right now.");
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  async function joinGroupCall(groupCallId, roomId, callType, isHost) {
    const me = window.EchoApp.getMe();
    try {
      var joinAck = await EchoSocket.emitAck("group-call:join", { groupCallId });
    } catch (err) {
      EchoToast.error(err.message);
      return;
    }

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === "video" });
    } catch (err) {
      EchoToast.error("Could not access camera/microphone.");
      EchoSocket.emit("group-call:leave", { groupCallId });
      return;
    }

    state = {
      groupCallId,
      roomId,
      callType,
      hostId: joinAck.hostId ?? me.id,
      isHost,
      localStream,
      micOn: true,
      camOn: callType === "video",
      screenSharing: false,
      peers: new Map(),
      // Metadata for participants we've heard about but may not yet have a
      // peer connection for — lets a lazily-created peer (see onOffer) use
      // the real username/avatar instead of a "…" placeholder.
      knownParticipants: new Map(),
    };
    for (const p of joinAck.existingParticipants || []) {
      state.knownParticipants.set(p.id, { username: p.username, avatarUrl: p.avatarUrl });
    }

    renderGrid();
    startQualityMonitor();

    // Create a peer connection toward each participant who was already in
    // the call and offer to them (we're the new arrival).
    for (const p of joinAck.existingParticipants || []) {
      await createPeer(p.id, p.username, p.avatarUrl, true);
    }
  }

  /* ============================== Peer connection management ============================== */

  async function createPeer(peerId, username, avatarUrl, initiateOffer) {
    if (!state || state.peers.has(peerId)) return state?.peers.get(peerId);

    const pc = new RTCPeerConnection({ iceServers });
    const peer = {
      pc,
      stream: null,
      username,
      avatarUrl,
      micOn: true,
      camOn: state.callType === "video",
      remoteDescriptionSet: false,
      pendingCandidates: [],
    };
    state.peers.set(peerId, peer);

    state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

    // If we're already screen-sharing when this peer connection is created
    // (i.e. someone joins the call mid-share), the tracks just added above
    // are the camera's — swap in the current screen track so the new
    // participant sees the same thing everyone else already does, instead
    // of our camera.
    if (state.screenSharing && state.screenShareStream) {
      const screenTrack = state.screenShareStream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender && screenTrack) sender.replaceTrack(screenTrack).catch(() => {});
    }

    pc.ontrack = (event) => {
      peer.stream = event.streams[0];
      renderGrid();
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        EchoSocket.emit("group-call:ice-candidate", { groupCallId: state.groupCallId, toUserId: peerId, candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) renderGrid();
    };

    renderGrid();

    if (initiateOffer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      EchoSocket.emit("group-call:offer", { groupCallId: state.groupCallId, toUserId: peerId, sdpOffer: offer });
    }

    return peer;
  }

  async function flushPendingCandidates(peer) {
    peer.remoteDescriptionSet = true;
    const queued = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        // A genuinely malformed/stale candidate — safe to drop only *after*
        // we've actually tried to apply it (as opposed to never trying).
      }
    }
  }

  async function onOffer({ fromUserId, sdpOffer }) {
    if (!state) return;
    let peer = state.peers.get(fromUserId);
    if (!peer) {
      const known = state.knownParticipants.get(fromUserId);
      peer = await createPeer(fromUserId, known?.username || "…", known?.avatarUrl || null, false);
    }
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));
    await flushPendingCandidates(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    EchoSocket.emit("group-call:answer", { groupCallId: state.groupCallId, toUserId: fromUserId, sdpAnswer: answer });
  }

  async function onAnswer({ fromUserId, sdpAnswer }) {
    const peer = state?.peers.get(fromUserId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
    await flushPendingCandidates(peer);
  }

  async function onIceCandidate({ fromUserId, candidate }) {
    const peer = state?.peers.get(fromUserId);
    if (!peer || !candidate) return;
    // A candidate can legitimately arrive before setRemoteDescription() has
    // run (signaling races ahead of SDP exchange) — queue it instead of
    // trying-and-discarding, and replay it once the remote description is set.
    if (!peer.remoteDescriptionSet) {
      peer.pendingCandidates.push(candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      // Applied after the remote description was set and still failed —
      // genuinely malformed/stale, safe to drop.
    }
  }

  /* ============================== Room-level events ============================== */

  async function onParticipantJoined({ participant }) {
    if (!state) return;
    state.knownParticipants.set(participant.id, { username: participant.username, avatarUrl: participant.avatarUrl });
    // We're an existing participant — the new arrival will offer to us, we
    // just need a (not-yet-connected) tile placeholder + peer entry ready
    // to receive that offer. Actual RTCPeerConnection gets created lazily
    // inside onOffer() when their offer lands, to avoid double-creating it.
    renderGrid();
  }

  function onParticipantLeft({ userId }) {
    if (!state) return;
    const peer = state.peers.get(userId);
    if (peer) { peer.pc.close(); state.peers.delete(userId); }
    renderGrid();
  }

  function onForceMute() {
    if (!state || !state.micOn) return;
    toggleMic(true);
    EchoToast.info("The host muted everyone.");
  }

  function onRemoved() {
    EchoToast.error("You were removed from the call.");
    teardown();
  }

  function onCallEnded({ reason }) {
    if (!state) return;
    EchoToast.info(reason === "room-deleted" ? "This call ended because the room was deleted." : "The call has ended.");
    teardown();
  }

  function onHostChanged({ hostId }) {
    if (!state) return;
    state.hostId = hostId;
    renderGrid();
    if (hostId === window.EchoApp.getMe().id) EchoToast.info("You're now the call host.");
  }

  function onLockChanged({ locked }) {
    if (!state) return;
    const lockBtn = document.getElementById("gc-lock");
    if (lockBtn) lockBtn.classList.toggle("active", locked);
  }

  /** Receives whatever `group-call:state` broadcasts peers send — mic
   * mute/unmute and reactions currently. This channel already existed
   * (toggleMic() above emits on it) but nothing was ever listening on the
   * receiving end, so a muted badge on another participant's tile never
   * actually updated. */
  function onGroupCallState({ userId, state: peerState }) {
    if (!state || !peerState) return;
    const peer = state.peers.get(userId);
    if (peer && peerState.micOn !== undefined) {
      peer.micOn = peerState.micOn;
      renderGrid();
    }
    if (peerState.reaction) {
      EchoCallFx.spawnFloatingReaction(document.getElementById("gc-reaction-layer"), peerState.reaction);
    }
  }

  async function toggleScreenShare() {
    if (!state.screenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Mesh screen share: replace the outgoing video track on every peer
        // connection at once, not just one — otherwise only one participant
        // would see the shared screen.
        for (const [, peer] of state.peers) {
          const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === "video");
          if (sender) await sender.replaceTrack(screenTrack);
        }

        state.screenShareOriginalTrack = state.localStream.getVideoTracks()[0] || null;
        const myVideo = callRoot.querySelector(`[data-tile-id="${window.EchoApp.getMe().id}"] video`);
        if (myVideo) myVideo.srcObject = screenStream;
        state.screenShareStream = screenStream;

        screenTrack.onended = () => stopScreenShare();
        state.screenSharing = true;
        renderGrid();
      } catch (err) { /* user cancelled the screen picker */ }
    } else {
      stopScreenShare();
    }
  }

  async function stopScreenShare() {
    if (!state) return;
    const camTrack = state.screenShareOriginalTrack;
    for (const [, peer] of state.peers) {
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender && camTrack) await sender.replaceTrack(camTrack);
    }
    if (state.screenShareStream) state.screenShareStream.getTracks().forEach((t) => t.stop());
    state.screenSharing = false;
    renderGrid();
  }

  /* ============================== Connection quality ============================== */

  let qualityTimer = null;

  function startQualityMonitor() {
    stopQualityMonitor();
    qualityTimer = setInterval(async () => {
      if (!state || state.peers.size === 0) return;
      // Aggregate across every peer in the mesh rather than sampling just
      // one arbitrary connection — a single laggy peer used to make the
      // whole call look "poor" even when everyone else was fine, and vice
      // versa. Worst-tier-wins: the indicator reflects the least healthy
      // link, which is what actually matters to the person looking at it.
      let worstQuality = "excellent";
      const rank = { excellent: 0, good: 1, poor: 2 };
      for (const [, peer] of state.peers) {
        try {
          const stats = await peer.pc.getStats();
          let packetsLost = 0, packetsReceived = 0, rtt = 0;
          stats.forEach((report) => {
            if (report.type === "inbound-rtp" && !report.isRemote) {
              packetsLost += report.packetsLost || 0;
              packetsReceived += report.packetsReceived || 0;
            }
            if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime) {
              rtt = report.currentRoundTripTime;
            }
          });
          const lossRatio = packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
          let quality = "excellent";
          if (lossRatio > 0.08 || rtt > 0.3) quality = "poor";
          else if (lossRatio > 0.02 || rtt > 0.12) quality = "good";
          if (rank[quality] > rank[worstQuality]) worstQuality = quality;
        } catch (e) { /* this peer's stats not available yet — skip it, not fatal */ }
      }
      updateQualityIndicator(worstQuality);
    }, 4000);
  }

  function stopQualityMonitor() {
    if (qualityTimer) clearInterval(qualityTimer);
    qualityTimer = null;
  }

  function updateQualityIndicator(quality) {
    const el = document.getElementById("gc-quality");
    if (el) el.className = `conn-quality-v2 ${quality}`;
    const label = document.getElementById("gc-quality-label");
    if (label) label.textContent = quality === "excellent" ? "Excellent" : quality === "good" ? "Good" : "Poor";
  }

  /* ============================== UI ============================== */

  let layoutMode = "grid"; // "grid" | "speaker" — pure UI preference, no signaling involved
  let speakingPeerId = null; // whoever's audio is currently loudest, for speaker-view + tile highlight
  const peerLevelMeters = new Map(); // userId -> meter handle, so speaking-highlight works per participant

  function renderGrid() {
    if (!state) return;
    const me = window.EchoApp.getMe();
    const isHostNow = state.hostId === me.id;
    const count = state.peers.size + 1;
    const countAttr = count > 6 ? "more" : String(count);

    const selfTile = renderTile(me.id, me.username, me.avatarUrl, state.localStream, state.micOn, state.camOn, true, isHostNow);
    const peerTiles = [...state.peers].map(([peerId, peer]) =>
      renderTile(peerId, peer.username, peer.avatarUrl, peer.stream, peer.micOn, peer.camOn, false, state.hostId === peerId)
    );

    const isSpeaker = layoutMode === "speaker" && count > 2;
    let stageHtml;
    if (isSpeaker) {
      const mainId = speakingPeerId || [...state.peers.keys()][0] || me.id;
      const allTiles = [{ id: me.id, html: selfTile }, ...[...state.peers.keys()].map((id, i) => ({ id, html: peerTiles[i] }))];
      const main = allTiles.find((t) => t.id === mainId) || allTiles[0];
      const rest = allTiles.filter((t) => t.id !== main.id);
      stageHtml = `
        <div class="gc-grid-v2 speaker-view" data-count="${countAttr}">
          <div class="is-speaker-main">${main.html.replace('class="gc-tile', 'class="gc-tile is-speaker-main')}</div>
          <div class="gc-filmstrip">${rest.map((t) => t.html).join("")}</div>
        </div>`;
    } else {
      stageHtml = `<div class="gc-grid-v2" data-count="${countAttr}">${selfTile}${peerTiles.join("")}</div>`;
    }

    callRoot.innerHTML = `
      <div class="call-overlay-v2 video-mode" id="gc-overlay-root">
        <div class="call-header-v2">
          <div class="call-header-left">
            <div>
              <div class="call-peer-name">Group ${state.callType} call</div>
              <div class="call-status-line connected"><span class="dot"></span><span>${count} participant${count === 1 ? "" : "s"}</span></div>
            </div>
          </div>
          <div class="call-header-badges">
            <div class="conn-quality-v2 excellent" id="gc-quality" title="Connection quality">
              <div class="bars"><span></span><span></span><span></span></div>
              <span id="gc-quality-label">Excellent</span>
            </div>
            ${isHostNow ? `
            <button class="call-fab small has-tooltip" id="gc-lock" data-tooltip="Lock call" aria-label="Lock call"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></button>
            <button class="call-fab small has-tooltip" id="gc-mute-all" data-tooltip="Mute everyone" aria-label="Mute everyone"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="3" y1="3" x2="21" y2="21"/></svg></button>` : ""}
          </div>
        </div>

        <div class="gc-stage-v2" id="gc-stage">
          ${count > 1 ? `
          <div class="gc-layout-toggle">
            <button class="has-tooltip ${layoutMode === "grid" ? "active" : ""}" id="gc-layout-grid" data-tooltip="Grid view" aria-label="Grid view"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
            <button class="has-tooltip ${layoutMode === "speaker" ? "active" : ""}" id="gc-layout-speaker" data-tooltip="Speaker view" aria-label="Speaker view"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="13" rx="1"/><rect x="3" y="19" width="4" height="2"/><rect x="9" y="19" width="4" height="2"/></svg></button>
          </div>` : ""}
          ${stageHtml}
          <div class="call-reaction-layer" id="gc-reaction-layer"></div>
        </div>

        <div class="call-controls-v2" id="gc-controls-bar">
          <button class="call-fab ${state.micOn ? "active" : ""} has-tooltip" id="gc-toggle-mic" data-tooltip="Mute" aria-label="Mute microphone" aria-pressed="${!state.micOn}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg></button>
          ${state.callType === "video" ? `<button class="call-fab ${state.camOn ? "active" : ""} has-tooltip" id="gc-toggle-cam" data-tooltip="Camera" aria-label="Toggle camera"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m23 7-7 5 7 5V7Z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></button>
          <button class="call-fab ${state.screenSharing ? "active" : ""} has-tooltip" id="gc-screen-share" data-tooltip="Share screen" aria-label="Share screen"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>` : ""}
          <button class="call-fab has-tooltip" id="gc-reactions" data-tooltip="Reactions" aria-label="Send a reaction">😊</button>
          <button class="call-fab end has-tooltip" id="gc-leave" data-tooltip="Leave call" aria-label="Leave call"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" transform="rotate(135 12 12)"/></svg></button>
        </div>
      </div>
    `;

    // Re-attach live MediaStreams (innerHTML rebuilds destroy any previous
    // srcObject bindings, so video elements need reconnecting every render).
    const myVideo = callRoot.querySelector(`[data-tile-id="${me.id}"] video`);
    if (myVideo) myVideo.srcObject = state.localStream;
    for (const [peerId, peer] of state.peers) {
      const v = callRoot.querySelector(`[data-tile-id="${peerId}"] video`);
      if (v && peer.stream) v.srcObject = peer.stream;
    }

    EchoCallFx.enhanceButtons(document.getElementById("gc-overlay-root"));

    document.getElementById("gc-toggle-mic").addEventListener("click", () => toggleMic());
    document.getElementById("gc-toggle-cam")?.addEventListener("click", toggleCam);
    document.getElementById("gc-screen-share")?.addEventListener("click", toggleScreenShare);
    document.getElementById("gc-leave").addEventListener("click", leaveCall);
    document.getElementById("gc-reactions").addEventListener("click", openGroupReactionBar);
    document.getElementById("gc-layout-grid")?.addEventListener("click", () => { layoutMode = "grid"; renderGrid(); });
    document.getElementById("gc-layout-speaker")?.addEventListener("click", () => { layoutMode = "speaker"; renderGrid(); });
    document.getElementById("gc-mute-all")?.addEventListener("click", async () => {
      try { await EchoSocket.emitAck("group-call:mute-all", { groupCallId: state.groupCallId }); EchoToast.success("Muted everyone."); }
      catch (err) { EchoToast.error(err.message); }
    });
    let locked = false;
    document.getElementById("gc-lock")?.addEventListener("click", async (e) => {
      locked = !locked;
      try {
        await EchoSocket.emitAck("group-call:lock", { groupCallId: state.groupCallId, locked });
        e.currentTarget.classList.toggle("active", locked);
        EchoToast.info(locked ? "Call locked — no new joins." : "Call unlocked.");
      } catch (err) { EchoToast.error(err.message); }
    });

    callRoot.querySelectorAll(".group-tile-menu-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const targetId = btn.dataset.userId;
        const rect = btn.getBoundingClientRect();
        EchoContextMenu.open(rect.left, rect.bottom + 6, [
          { label: "Remove from call", danger: true, onClick: () => removeParticipant(targetId) },
        ]);
      });
    });

    watchSpeakingLevels();
  }

  function renderTile(id, username, avatarUrl, stream, micOn, camOn, isSelf, isHostTile) {
    const showVideo = stream && camOn;
    const speaking = id === speakingPeerId;
    return `
      <div class="gc-tile${speaking ? " speaking" : ""}" data-tile-id="${id}">
        ${showVideo ? `<video autoplay playsinline ${isSelf ? "muted" : ""}></video>` : `<div class="avatar-fallback">${initials(username)}</div>`}
        <div class="gc-tile-label">${!micOn ? '<span class="mic-off-icon">🔇</span>' : ""}${escapeHtml(username)}${isSelf ? " (you)" : ""}</div>
        ${isHostTile ? `<span class="gc-host-badge">Host</span>` : ""}
        ${!isSelf && state.isHost ? `<button class="group-tile-menu-btn has-tooltip" data-tooltip="Options" data-user-id="${id}" style="position:absolute; top:8px; left:8px; width:28px; height:28px; border-radius:50%; border:none; background:rgba(0,0,0,0.5); color:#fff; cursor:pointer;">⋯</button>` : ""}
      </div>`;
  }

  /** Runs one lightweight audio-level analysis per participant with a live
   * stream, to drive the speaking-tile highlight and speaker-view "main"
   * selection. Re-run on every renderGrid() since the DOM (and therefore
   * any previous analyser targets) gets rebuilt each time. */
  function watchSpeakingLevels() {
    for (const [, meter] of peerLevelMeters) meter.stop();
    peerLevelMeters.clear();
    if (!state) return;

    const track = (stream) => stream && stream.getAudioTracks().length > 0;
    if (track(state.localStream)) {
      peerLevelMeters.set(window.EchoApp.getMe().id, EchoCallFx.createAudioLevelMeter(state.localStream, (level) => markSpeaking(window.EchoApp.getMe().id, level)));
    }
    for (const [peerId, peer] of state.peers) {
      if (track(peer.stream)) {
        peerLevelMeters.set(peerId, EchoCallFx.createAudioLevelMeter(peer.stream, (level) => markSpeaking(peerId, level)));
      }
    }
  }

  let lastSpeakingRenderAt = 0;
  function markSpeaking(userId, level) {
    if (level < 0.15) return;
    if (speakingPeerId === userId) return;
    // Throttle re-renders — this fires on every animation frame across
    // every participant's analyser, but the tile highlight only needs to
    // update a few times a second at most.
    const now = Date.now();
    if (now - lastSpeakingRenderAt < 600) return;
    lastSpeakingRenderAt = now;
    speakingPeerId = userId;
    document.querySelectorAll(".gc-tile").forEach((t) => t.classList.toggle("speaking", t.dataset.tileId === userId));
  }

  /** Reactions reuse the existing generic group-call:state relay (already
   * forwarded blindly to the whole call room by the server) — no new
   * signaling was added for this. */
  function openGroupReactionBar() {
    document.querySelector(".call-reaction-bar")?.remove();
    const bar = document.createElement("div");
    bar.className = "call-reaction-bar";
    ["❤️", "👍", "😂", "👏", "🔥"].forEach((emoji) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = emoji;
      btn.setAttribute("aria-label", `Send ${emoji} reaction`);
      btn.addEventListener("click", () => {
        EchoCallFx.spawnFloatingReaction(document.getElementById("gc-reaction-layer"), emoji);
        EchoSocket.emit("group-call:state", { groupCallId: state.groupCallId, state: { userId: window.EchoApp.getMe().id, reaction: emoji } });
        bar.remove();
      });
      bar.appendChild(btn);
    });
    document.getElementById("gc-stage").appendChild(bar);
    setTimeout(() => document.addEventListener("pointerdown", closeOnce), 0);
    function closeOnce(e) { if (!bar.contains(e.target)) { bar.remove(); document.removeEventListener("pointerdown", closeOnce); } }
  }

  function toggleMic(forceOff) {
    state.micOn = forceOff ? false : !state.micOn;
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
    for (const [peerId] of state.peers) {
      EchoSocket.emit("group-call:state", { groupCallId: state.groupCallId, state: { userId: window.EchoApp.getMe().id, micOn: state.micOn } });
      break; // one broadcast is enough — server relays to the whole call room, not per-peer
    }
    renderGrid();
  }

  function toggleCam() {
    state.camOn = !state.camOn;
    state.localStream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
    renderGrid();
  }

  async function removeParticipant(userId) {
    try {
      await EchoSocket.emitAck("group-call:remove-participant", { groupCallId: state.groupCallId, userId });
    } catch (err) {
      EchoToast.error(err.message);
    }
  }

  function leaveCall() {
    if (state) EchoSocket.emit("group-call:leave", { groupCallId: state.groupCallId });
    teardown();
  }

  function teardown() {
    if (!state) return;
    stopQualityMonitor();
    for (const [, meter] of peerLevelMeters) meter.stop();
    peerLevelMeters.clear();
    speakingPeerId = null;
    if (state.screenShareStream) state.screenShareStream.getTracks().forEach((t) => t.stop());
    state.localStream.getTracks().forEach((t) => t.stop());
    for (const [, peer] of state.peers) peer.pc.close();
    state = null;
    callRoot.innerHTML = "";
  }

  /* ============================== Member picker (for "specific members" group calls) ============================== */

  function openMemberPicker(roomId, callType, members) {
    const backdrop = EchoModal.open("tpl-group-call-picker");
    const list = backdrop.querySelector("#gcp-member-list");
    list.innerHTML = members
      .map(
        (m) => `
      <label class="room-item" style="cursor:pointer;">
        <input type="checkbox" value="${m.id}" style="margin-right:10px;" />
        <div class="avatar-fallback" style="width:30px;height:30px;font-size:11px;">${initials(m.username)}</div>
        <div class="room-meta"><div class="room-name" style="font-size:13px;">${escapeHtml(m.username)}</div></div>
      </label>`
      )
      .join("");

    backdrop.querySelector("#gcp-start").addEventListener("click", () => {
      const memberIds = [...list.querySelectorAll("input:checked")].map((i) => i.value);
      if (memberIds.length === 0) return EchoToast.error("Select at least one member.");
      EchoModal.close();
      startGroupCall(roomId, callType, memberIds);
    });
  }

  /* ============================== Wire socket events ============================== */

  function initGroupCallListeners() {
    EchoSocket.on("group-call:invite", showIncomingGroupCall);
    EchoSocket.on("group-call:participant-joined", onParticipantJoined);
    EchoSocket.on("group-call:participant-left", onParticipantLeft);
    EchoSocket.on("group-call:offer", onOffer);
    EchoSocket.on("group-call:answer", onAnswer);
    EchoSocket.on("group-call:ice-candidate", onIceCandidate);
    EchoSocket.on("group-call:force-mute", onForceMute);
    EchoSocket.on("group-call:removed", onRemoved);
    EchoSocket.on("group-call:ended", onCallEnded);
    EchoSocket.on("group-call:host-changed", onHostChanged);
    EchoSocket.on("group-call:lock-changed", onLockChanged);
    EchoSocket.on("group-call:state", onGroupCallState);
  }

  window.EchoGroupCall = { init: initGroupCallListeners, start: startGroupCall, openMemberPicker, isInCall: () => !!state };
})();
