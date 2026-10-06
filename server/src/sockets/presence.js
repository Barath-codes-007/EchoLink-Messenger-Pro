"use strict";

const db = require("../db");
const { getMembership, getMemberCount, roomSummary } = require("../controllers/room.controller");
const { hasOtherActiveSockets } = require("../utils/multiSocket");

// roomId -> Set<socketId> of sockets currently viewing that room (for live
// "who's online in this room" — separate from total membership count).
const activeRoomSockets = new Map();

function socketsInRoom(roomId) {
  return activeRoomSockets.get(roomId) || new Set();
}

function broadcastPresence(io, roomId) {
  const socketIds = socketsInRoom(roomId);
  // Dedupe by user, not by socket — the same user with two tabs open in a
  // room previously counted (and appeared in the list) twice.
  const seen = new Map();
  for (const id of socketIds) {
    const u = io.sockets.sockets.get(id)?.data.user;
    if (u) seen.set(u.id, u.username);
  }
  io.to(roomId).emit("presence:update", { roomId, onlineCount: seen.size, onlineUsers: [...seen.values()] });
}

function registerPresenceHandlers(io, socket) {
  const user = socket.data.user;

  socket.on("room:join", ({ roomId }, ack) => {
    const membership = getMembership(roomId, user.id);
    if (!membership || membership.banned) {
      return ack?.({ ok: false, error: "You are not a member of this room." });
    }

    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!room) return ack?.({ ok: false, error: "Room not found." });

    socket.join(roomId);
    socket.data.rooms = socket.data.rooms || new Set();
    socket.data.rooms.add(roomId);

    if (!activeRoomSockets.has(roomId)) activeRoomSockets.set(roomId, new Set());
    activeRoomSockets.get(roomId).add(socket.id);

    socket.to(roomId).emit("presence:user-joined", { username: user.username, userId: user.id });
    broadcastPresence(io, roomId);

    ack?.({ ok: true, room: { ...roomSummary(room, getMemberCount(roomId)), myRole: membership.role } });
  });

  socket.on("room:leave", ({ roomId }) => {
    socket.leave(roomId);
    socket.data.rooms?.delete(roomId);
    activeRoomSockets.get(roomId)?.delete(socket.id);
    socket.to(roomId).emit("presence:user-left", { username: user.username, userId: user.id });
    broadcastPresence(io, roomId);
  });

  socket.on("presence:status", ({ status }) => {
    if (!["online", "away", "dnd", "invisible"].includes(status)) return;
    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, user.id);
    for (const roomId of socket.data.rooms || []) {
      io.to(roomId).emit("presence:status-changed", { userId: user.id, status });
    }
  });

  socket.on("disconnect", () => {
    // This socket going away doesn't mean the *user* is gone — they may
    // still have another tab or device connected. Only flip them to
    // offline and tell rooms they've left once their last socket drops.
    const stillHasOtherSockets = hasOtherActiveSockets(io, user.id, socket.id);

    for (const roomId of socket.data.rooms || []) {
      activeRoomSockets.get(roomId)?.delete(socket.id);
      if (!stillHasOtherSockets) {
        socket.to(roomId).emit("presence:user-left", { username: user.username, userId: user.id });
      }
      broadcastPresence(io, roomId);
    }

    if (!stillHasOtherSockets) {
      db.prepare("UPDATE users SET status = 'offline', last_seen_at = strftime('%s','now') WHERE id = ?").run(user.id);
    }
  });
}

module.exports = registerPresenceHandlers;
