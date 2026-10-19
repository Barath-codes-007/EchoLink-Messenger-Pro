"use strict";

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { getMembership } = require("../controllers/room.controller");
const { isBlocked } = require("../utils/blocking");
const { allow } = require("../utils/socketRateLimit");

// callId -> { roomId, callerId, calleeId, callerSocketId, calleeSocketId,
//             callType, startedAt, connectedAt, ringTimer }
//
// callerSocketId/calleeSocketId are the *specific* socket actually running
// this call's RTCPeerConnection — set once (invite, and again on accept)
// and never re-resolved by "any socket this user currently has open".
// A user can have several tabs/devices connected at once; resolving
// signaling by userId+room membership alone (as this used to work) means
// an SDP offer/answer/ICE candidate can be delivered to the *wrong* tab of
// the same user — one that never ran setupPeerConnection() for this call —
// which just silently drops it and leaves the call stuck in "connecting"
// forever. Binding to the exact socket that accepted fixes that.
const activeCalls = new Map();

const RING_TIMEOUT_MS = 45000; // matches the 30-60s window called for by the spec

function findSocketByUserId(io, roomId, userId) {
  for (const [, s] of io.sockets.sockets) {
    if (s.data.user?.id === userId && s.rooms.has(roomId)) return s;
  }
  return null;
}

// Every signaling event after the initial invite carries a callId supplied
// by the client. Without this check, any authenticated user who learns or
// guesses a callId (call IDs are UUIDs, but nothing before this fix stopped
// a malicious/compromised client from trying arbitrary values or replaying
// one it observed) could accept/end someone else's call, inject fake ICE
// candidates, or spoof mute/camera state for a call they aren't part of.
function requireParticipant(call, userId) {
  return !!call && (call.callerId === userId || call.calleeId === userId);
}

function clearRingTimer(call) {
  if (call.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = null;
  }
}

function logCall({ roomId, callerId, calleeId, callType, status, startedAt, connectedAt, endedAt }) {
  const durationBase = connectedAt || null;
  db.prepare(
    `INSERT INTO call_logs (id, room_id, caller_id, callee_id, call_type, status, started_at, ended_at, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    roomId,
    callerId,
    calleeId,
    callType,
    status,
    Math.floor(startedAt / 1000),
    endedAt ? Math.floor(endedAt / 1000) : null,
    durationBase && endedAt ? Math.max(0, Math.round((endedAt - durationBase) / 1000)) : 0
  );
}

/** Ends and logs every active call in a room as a side effect of the room
 * itself being deleted (explicit delete or temporary-room expiration) —
 * otherwise activeCalls entries for that room are orphaned forever and
 * connected clients are never told to tear down their WebRTC state. */
function endCallsForRoom(io, roomId) {
  for (const [callId, call] of activeCalls) {
    if (call.roomId !== roomId) continue;
    clearRingTimer(call);
    const status = call.connectedAt ? "disconnected" : "cancelled";
    logCall({ ...call, status, endedAt: Date.now() });
    io.to(`user:${call.callerId}`).emit("call:ended", { callId, reason: "room-deleted" });
    io.to(`user:${call.calleeId}`).emit("call:ended", { callId, reason: "room-deleted" });
    activeCalls.delete(callId);
  }
}

function registerCallHandlers(io, socket) {
  const user = socket.data.user;

  // Caller initiates a 1:1 call to another member currently present in the room.
  socket.on("call:invite", ({ roomId, calleeId, callType }, ack) => {
    if (!allow(`call-invite:${user.id}`, 10, 60_000)) {
      return ack?.({ ok: false, error: "Too many call attempts — please wait a moment." });
    }
    if (!getMembership(roomId, user.id) || !getMembership(roomId, calleeId)) {
      return ack?.({ ok: false, error: "Both users must be members of this room." });
    }
    if (isBlocked(user.id, calleeId)) {
      // Deliberately vague error — don't reveal to the caller *why* the
      // call can't go through (i.e. don't leak block status either way).
      return ack?.({ ok: false, error: "This user is unavailable." });
    }
    if (!findSocketByUserId(io, roomId, calleeId)) {
      return ack?.({ ok: false, error: "That user is not currently online in this room." });
    }

    const callId = uuidv4();
    const call = {
      roomId,
      callerId: user.id,
      calleeId,
      callerSocketId: socket.id, // this exact socket is the one that will run the offer
      calleeSocketId: null, // set once the callee actually accepts (see call:respond)
      callType: callType === "video" ? "video" : "voice",
      startedAt: Date.now(),
      connectedAt: null,
      ringTimer: null,
    };
    activeCalls.set(callId, call);

    // If nobody answers within the ring window, end the call cleanly instead
    // of leaving it (and any client-side "Calling..." UI) hanging forever.
    call.ringTimer = setTimeout(() => {
      const stillActive = activeCalls.get(callId);
      if (!stillActive || stillActive.connectedAt) return;
      logCall({ ...stillActive, status: "timeout", endedAt: Date.now() });
      activeCalls.delete(callId);
      // Nobody has accepted yet on any tab, so it's always safe to tell
      // every device/tab of both users to dismiss.
      io.to(`user:${stillActive.callerId}`).emit("call:ended", { callId, reason: "timeout" });
      io.to(`user:${stillActive.calleeId}`).emit("call:ended", { callId, reason: "timeout" });
    }, RING_TIMEOUT_MS);

    // Ring every device/tab the callee currently has open — not just
    // whichever one happened to be first in the socket list — so they can
    // answer from whichever one they're actually using.
    io.to(`user:${calleeId}`).emit("call:incoming", {
      callId,
      roomId,
      callType,
      from: { id: user.id, username: user.username, avatarUrl: user.avatar_url },
    });
    ack?.({ ok: true, callId });
  });

  // Callee's accept/decline decision — no SDP yet. Accepting tells the
  // caller to go ahead and create the WebRTC offer.
  socket.on("call:respond", ({ callId, accept }, ack) => {
    const call = activeCalls.get(callId);
    if (!requireParticipant(call, user.id) || call.calleeId !== user.id) {
      return ack?.({ ok: false, error: "This call is no longer available." });
    }
    clearRingTimer(call);

    if (!accept) {
      logCall({ ...call, status: "declined", endedAt: Date.now() });
      activeCalls.delete(callId);
      io.to(`user:${call.callerId}`).emit("call:declined", { callId });
      // Other tabs/devices of the same callee were ringing too — this one
      // already handled its own UI locally, so just tell the rest.
      socket.to(`user:${call.calleeId}`).emit("call:ended", { callId, reason: "declined-elsewhere" });
      return ack?.({ ok: true });
    }

    // Bind the call to *this* specific socket — the offer, answer, and every
    // ICE candidate that follows must go to/from this exact tab, not
    // "whichever socket this user happens to have open right now".
    call.calleeSocketId = socket.id;
    io.to(`user:${call.callerId}`).emit("call:accepted", { callId });
    // Dismiss ringing on this same user's *other* tabs/devices without
    // touching this one — broadcasting a plain "call:ended" to the whole
    // user room here would immediately kill the call this socket just
    // accepted, since it can't tell "answered elsewhere" apart from
    // "actually over". socket.to() excludes the sender for exactly this.
    socket.to(`user:${call.calleeId}`).emit("call:ended", { callId, reason: "answered-elsewhere" });
    ack?.({ ok: true });
  });

  // Caller -> callee: the WebRTC offer, sent only after the callee accepted.
  socket.on("call:offer", ({ callId, sdpOffer }) => {
    const call = activeCalls.get(callId);
    if (!call || call.callerId !== user.id || call.callerSocketId !== socket.id) return;
    if (!call.calleeSocketId) return; // accept hasn't bound a socket yet — nothing to send to
    io.sockets.sockets.get(call.calleeSocketId)?.emit("call:offer", { callId, sdpOffer });
  });

  // Callee -> caller: the WebRTC answer.
  socket.on("call:answer", ({ callId, sdpAnswer }) => {
    const call = activeCalls.get(callId);
    if (!call || call.calleeId !== user.id || call.calleeSocketId !== socket.id) return;
    call.connectedAt = call.connectedAt || Date.now();
    io.sockets.sockets.get(call.callerSocketId)?.emit("call:answer", { callId, sdpAnswer });
  });

  socket.on("call:ice-candidate", ({ callId, candidate, toUserId }) => {
    const call = activeCalls.get(callId);
    if (!requireParticipant(call, user.id)) return;
    // Must come from — and be relayed to — the exact sockets bound to this
    // call, not just "some socket belonging to the right user".
    const isCaller = call.callerId === user.id;
    if (isCaller && call.callerSocketId !== socket.id) return;
    if (!isCaller && call.calleeSocketId !== socket.id) return;
    const otherId = isCaller ? call.calleeId : call.callerId;
    if (toUserId !== otherId) return;
    const targetSocketId = isCaller ? call.calleeSocketId : call.callerSocketId;
    if (!targetSocketId) return;
    io.sockets.sockets.get(targetSocketId)?.emit("call:ice-candidate", { callId, candidate, fromUserId: user.id });
  });

  socket.on("call:state", ({ callId, state, toUserId }) => {
    // Relays mute/unmute, camera on/off, screen-share on/off toggles to the peer.
    const call = activeCalls.get(callId);
    if (!requireParticipant(call, user.id)) return;
    const isCaller = call.callerId === user.id;
    if (isCaller && call.callerSocketId !== socket.id) return;
    if (!isCaller && call.calleeSocketId !== socket.id) return;
    const otherId = isCaller ? call.calleeId : call.callerId;
    if (toUserId !== otherId) return;
    const targetSocketId = isCaller ? call.calleeSocketId : call.callerSocketId;
    if (!targetSocketId) return;
    io.sockets.sockets.get(targetSocketId)?.emit("call:state", { callId, state, fromUserId: user.id });
  });

  socket.on("call:end", ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!requireParticipant(call, user.id)) return;
    clearRingTimer(call);

    // Distinguish "caller hung up before it was ever answered" (cancelled)
    // from a normal hangup after the call actually connected (completed).
    const status = call.connectedAt ? "completed" : "cancelled";
    logCall({ ...call, status, endedAt: Date.now() });

    io.to(`user:${call.callerId}`).emit("call:ended", { callId });
    io.to(`user:${call.calleeId}`).emit("call:ended", { callId });
    activeCalls.delete(callId);
  });

  socket.on("disconnect", () => {
    for (const [callId, call] of activeCalls) {
      // Only the specific socket actually bound to this call ending should
      // end the call — an unrelated tab/device of the same user
      // disconnecting has nothing to do with this call's peer connection.
      const isBoundSocket = call.callerSocketId === socket.id || call.calleeSocketId === socket.id;
      if (!isBoundSocket) continue;

      clearRingTimer(call);
      // A drop after the call had already connected is a disconnect, not
      // a missed call — those mean very different things in call history.
      const status = call.connectedAt ? "disconnected" : "missed";
      logCall({ ...call, status, endedAt: Date.now() });
      const otherId = call.callerId === user.id ? call.calleeId : call.callerId;
      io.to(`user:${otherId}`).emit("call:ended", { callId, reason: "peer-disconnected" });
      activeCalls.delete(callId);
    }
  });
}

module.exports = registerCallHandlers;
module.exports.endCallsForRoom = endCallsForRoom;

/** Defensive safety net: removes any call whose bound socket(s) are no
 * longer actually connected. Every normal exit path (respond/end/disconnect
 * handlers above) already cleans up activeCalls correctly — this only
 * catches the rare case where a disconnect event is somehow missed (e.g.
 * a process-level crash mid-handler), so this map can't grow unboundedly
 * over a long-running server process. */
function sweepAbandonedCalls(io) {
  const now = Date.now();
  for (const [callId, call] of activeCalls) {
    const callerGone = call.callerSocketId && !io.sockets.sockets.has(call.callerSocketId);
    const calleeGone = call.calleeSocketId && !io.sockets.sockets.has(call.calleeSocketId);
    // Also catch a call that's been "ringing" far longer than the ring
    // timeout ever should have allowed (its timer itself failing somehow).
    const stale = !call.connectedAt && now - call.startedAt > 5 * 60 * 1000;
    if (callerGone || calleeGone || stale) {
      clearRingTimer(call);
      logCall({ ...call, status: call.connectedAt ? "disconnected" : "missed", endedAt: now });
      activeCalls.delete(callId);
    }
  }
}
module.exports.sweepAbandonedCalls = sweepAbandonedCalls;
