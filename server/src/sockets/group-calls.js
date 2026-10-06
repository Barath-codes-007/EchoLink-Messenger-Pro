"use strict";

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { getMembership } = require("../controllers/room.controller");
const { isBlocked } = require("../utils/blocking");
const { allow } = require("../utils/socketRateLimit");

// groupCallId -> { roomId, callType, hostId, locked, startedAt,
//                  participants: Map<userId, { username, avatarUrl, socketId }> }
const activeGroupCalls = new Map();

function socketRoomName(groupCallId) {
  return `group-call:${groupCallId}`;
}

/** Ends every active group call in a room as a side effect of the room
 * itself being deleted (explicit delete or temporary-room expiration).
 * Without this, activeGroupCalls entries for that room are orphaned and
 * connected clients never learn to tear down their peer connections. */
function endGroupCallsForRoom(io, roomId) {
  for (const [groupCallId, call] of activeGroupCalls) {
    if (call.roomId !== roomId) continue;
    io.to(socketRoomName(groupCallId)).emit("group-call:ended", { groupCallId, reason: "room-deleted" });
    activeGroupCalls.delete(groupCallId);
  }
}

function logGroupCall(call, status) {
  db.prepare(
    `INSERT INTO call_logs (id, room_id, caller_id, callee_id, call_type, status, started_at, ended_at, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    call.roomId,
    call.hostId,
    null, // group calls don't map to a single callee — participants list isn't normalized here to keep scope reasonable
    call.callType,
    status,
    Math.floor(call.startedAt / 1000),
    Math.floor(Date.now() / 1000),
    Math.round((Date.now() - call.startedAt) / 1000)
  );
}

function participantList(call) {
  return [...call.participants.entries()].map(([id, info]) => ({ id, username: info.username, avatarUrl: info.avatarUrl }));
}

function registerGroupCallHandlers(io, socket) {
  const user = socket.data.user;

  // Host starts a group call. If memberIds is omitted, invites everyone
  // currently online in the room; otherwise invites just the given members.
  socket.on("group-call:start", ({ roomId, callType, memberIds }, ack) => {
    if (!allow(`group-call-start:${user.id}`, 6, 60_000)) {
      return ack?.({ ok: false, error: "Too many call attempts — please wait a moment." });
    }
    if (!getMembership(roomId, user.id)) return ack?.({ ok: false, error: "Not a member of this room." });

    const groupCallId = uuidv4();
    const call = {
      roomId,
      callType: callType === "video" ? "video" : "voice",
      hostId: user.id,
      locked: false,
      startedAt: Date.now(),
      participants: new Map([[user.id, { username: user.username, avatarUrl: user.avatar_url, socketId: socket.id }]]),
    };
    activeGroupCalls.set(groupCallId, call);
    socket.join(socketRoomName(groupCallId));

    const targets = memberIds && memberIds.length ? memberIds : null;
    let invited = 0;

    for (const [, s] of io.sockets.sockets) {
      if (s.data.user?.id === user.id) continue;
      if (!s.rooms.has(roomId)) continue; // only currently-present-in-room sockets can be invited
      if (targets && !targets.includes(s.data.user.id)) continue;
      if (isBlocked(user.id, s.data.user.id)) continue; // don't ring someone with a block relationship to the host

      s.emit("group-call:invite", {
        groupCallId,
        roomId,
        callType: call.callType,
        host: { id: user.id, username: user.username, avatarUrl: user.avatar_url },
      });
      invited++;
    }

    ack?.({ ok: true, groupCallId, invited });
  });

  socket.on("group-call:join", ({ groupCallId }, ack) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!call) return ack?.({ ok: false, error: "This call has ended." });
    if (call.locked) return ack?.({ ok: false, error: "This call is locked." });
    if (!getMembership(call.roomId, user.id)) return ack?.({ ok: false, error: "Not a member of this room." });
    if (isBlocked(user.id, call.hostId)) return ack?.({ ok: false, error: "You can't join this call." });
    // A user can have several tabs/devices open, but only one of them can
    // actually run this call's mesh connections — otherwise offers/answers/
    // ICE candidates meant for "this user" become ambiguous about which
    // tab should receive them. Reject joining twice rather than silently
    // rebinding, so the first tab doesn't get orphaned without warning.
    const already = call.participants.get(user.id);
    if (already && already.socketId !== socket.id && io.sockets.sockets.has(already.socketId)) {
      return ack?.({ ok: false, error: "You're already in this call from another tab or device." });
    }

    const existing = participantList(call);
    call.participants.set(user.id, { username: user.username, avatarUrl: user.avatar_url, socketId: socket.id });
    socket.join(socketRoomName(groupCallId));

    socket.to(socketRoomName(groupCallId)).emit("group-call:participant-joined", {
      groupCallId,
      participant: { id: user.id, username: user.username, avatarUrl: user.avatar_url },
    });

    ack?.({ ok: true, callType: call.callType, hostId: call.hostId, existingParticipants: existing });
  });

  socket.on("group-call:decline", ({ groupCallId }) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!call) return;
    const hostSocketId = call.participants.get(call.hostId)?.socketId;
    (hostSocketId && io.sockets.sockets.get(hostSocketId))?.emit("group-call:declined", { groupCallId, userId: user.id, username: user.username });
  });

  // ---- WebRTC signaling relay (mesh: existing participants offer to a
  // freshly-joined participant, who answers each of them individually) ----

  // Every signaling relay below must verify the sender — and, where the
  // client picks the target, the target too — are actual participants of
  // this exact call. Without this, any authenticated user who learns a
  // groupCallId could inject offers/answers/ICE candidates or spoof
  // mute/camera state into a call they were never invited to or already left.
  function isParticipant(call, userId) {
    return !!call && call.participants.has(userId);
  }

  /** Resolves a participant's userId to the exact socket bound to their
   * membership in this call — not "any socket this user currently has
   * open" (findSocketByUserId), which could be a tab that never joined
   * this call's mesh at all and would just silently drop the message. */
  function participantSocket(io, call, userId) {
    const socketId = call.participants.get(userId)?.socketId;
    return socketId ? io.sockets.sockets.get(socketId) : null;
  }

  socket.on("group-call:offer", ({ groupCallId, toUserId, sdpOffer }) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!isParticipant(call, user.id) || !isParticipant(call, toUserId)) return;
    if (call.participants.get(user.id)?.socketId !== socket.id) return;
    participantSocket(io, call, toUserId)?.emit("group-call:offer", { groupCallId, fromUserId: user.id, sdpOffer });
  });

  socket.on("group-call:answer", ({ groupCallId, toUserId, sdpAnswer }) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!isParticipant(call, user.id) || !isParticipant(call, toUserId)) return;
    if (call.participants.get(user.id)?.socketId !== socket.id) return;
    participantSocket(io, call, toUserId)?.emit("group-call:answer", { groupCallId, fromUserId: user.id, sdpAnswer });
  });

  socket.on("group-call:ice-candidate", ({ groupCallId, toUserId, candidate }) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!isParticipant(call, user.id) || !isParticipant(call, toUserId)) return;
    if (call.participants.get(user.id)?.socketId !== socket.id) return;
    participantSocket(io, call, toUserId)?.emit("group-call:ice-candidate", { groupCallId, fromUserId: user.id, candidate });
  });

  socket.on("group-call:state", ({ groupCallId, state }) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!isParticipant(call, user.id)) return;
    if (call.participants.get(user.id)?.socketId !== socket.id) return;
    socket.to(socketRoomName(groupCallId)).emit("group-call:state", { groupCallId, userId: user.id, state });
  });

  // ---- Host controls ----

  socket.on("group-call:mute-all", ({ groupCallId }, ack) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!call) return ack?.({ ok: false, error: "Call not found." });
    if (call.hostId !== user.id) return ack?.({ ok: false, error: "Only the host can mute everyone." });
    socket.to(socketRoomName(groupCallId)).emit("group-call:force-mute", { groupCallId });
    ack?.({ ok: true });
  });

  socket.on("group-call:lock", ({ groupCallId, locked }, ack) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!call) return ack?.({ ok: false, error: "Call not found." });
    if (call.hostId !== user.id) return ack?.({ ok: false, error: "Only the host can lock this call." });
    call.locked = !!locked;
    io.to(socketRoomName(groupCallId)).emit("group-call:lock-changed", { groupCallId, locked: call.locked });
    ack?.({ ok: true });
  });

  socket.on("group-call:remove-participant", ({ groupCallId, userId }, ack) => {
    const call = activeGroupCalls.get(groupCallId);
    if (!call) return ack?.({ ok: false, error: "Call not found." });
    if (call.hostId !== user.id) return ack?.({ ok: false, error: "Only the host can remove participants." });
    if (userId === call.hostId) return ack?.({ ok: false, error: "The host can't remove themselves this way — use leave." });

    const target = participantSocket(io, call, userId);
    call.participants.delete(userId);
    target?.leave(socketRoomName(groupCallId));
    target?.emit("group-call:removed", { groupCallId });
    io.to(socketRoomName(groupCallId)).emit("group-call:participant-left", { groupCallId, userId });
    ack?.({ ok: true });
  });

  socket.on("group-call:leave", ({ groupCallId }) => {
    leaveGroupCall(io, socket, groupCallId);
  });

  socket.on("disconnect", () => {
    for (const groupCallId of activeGroupCalls.keys()) {
      const call = activeGroupCalls.get(groupCallId);
      // Only this exact bound socket disconnecting should remove the
      // participant — an unrelated tab/device of the same user has
      // nothing to do with this call's mesh connections.
      if (call && call.participants.get(user.id)?.socketId === socket.id) leaveGroupCall(io, socket, groupCallId);
    }
  });
}

function leaveGroupCall(io, socket, groupCallId) {
  const call = activeGroupCalls.get(groupCallId);
  if (!call) return;
  const user = socket.data.user;
  if (call.participants.get(user.id)?.socketId !== socket.id) return;

  call.participants.delete(user.id);
  socket.leave(socketRoomName(groupCallId));
  socket.to(socketRoomName(groupCallId)).emit("group-call:participant-left", { groupCallId, userId: user.id });

  if (call.participants.size === 0) {
    logGroupCall(call, "completed");
    activeGroupCalls.delete(groupCallId);
  } else if (call.hostId === user.id) {
    // Promote the longest-standing remaining participant to host so mute-all/lock/remove still work.
    const nextHost = call.participants.keys().next().value;
    call.hostId = nextHost;
    io.to(socketRoomName(groupCallId)).emit("group-call:host-changed", { groupCallId, hostId: nextHost });
  }
}

module.exports = registerGroupCallHandlers;
module.exports.endGroupCallsForRoom = endGroupCallsForRoom;

/** Same defensive safety net as calls.js's sweepAbandonedCalls, for the
 * mesh group-call map. */
function sweepAbandonedGroupCalls(io) {
  for (const [groupCallId, call] of activeGroupCalls) {
    for (const [userId, info] of [...call.participants]) {
      if (!io.sockets.sockets.has(info.socketId)) call.participants.delete(userId);
    }
    if (call.participants.size === 0) {
      logGroupCall(call, "completed");
      activeGroupCalls.delete(groupCallId);
    }
  }
}
module.exports.sweepAbandonedGroupCalls = sweepAbandonedGroupCalls;
