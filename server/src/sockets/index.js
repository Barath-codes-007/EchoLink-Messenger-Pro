"use strict";

const cookie = require("cookie");
const config = require("../config");
const { verifyToken } = require("../services/token");
const db = require("../db");

const registerChatHandlers = require("./chat");
const registerCallHandlers = require("./calls");
const { endCallsForRoom } = registerCallHandlers;
const registerGroupCallHandlers = require("./group-calls");
const { endGroupCallsForRoom } = registerGroupCallHandlers;
const registerPresenceHandlers = require("./presence");
const roomEvents = require("../services/roomEvents");

/** Reads the JWT from the Socket.IO handshake (cookie or auth payload). */
function authenticateSocket(socket) {
  let token = socket.handshake.auth?.token;

  if (!token && socket.handshake.headers.cookie) {
    const parsed = cookie.parse(socket.handshake.headers.cookie);
    token = parsed[config.cookieName];
  }

  const payload = token && verifyToken(token);
  if (!payload) return null;

  return db.prepare("SELECT id, username, avatar_url, status FROM users WHERE id = ?").get(payload.sub);
}

function initSockets(io) {
  // A room being explicitly deleted (see room.controller.js deleteRoom)
  // previously left any active call in it orphaned and never told
  // connected clients — same cleanup the expiry/owner-logout sweeps do.
  roomEvents.on("room:deleted", ({ roomId, reason }) => {
    endCallsForRoom(io, roomId);
    endGroupCallsForRoom(io, roomId);
    io.to(roomId).emit("room:deleted", { roomId, reason });
  });

  io.use((socket, next) => {
    const user = authenticateSocket(socket);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.data.user.id}`);
    registerPresenceHandlers(io, socket);
    registerChatHandlers(io, socket);
    registerCallHandlers(io, socket);
    registerGroupCallHandlers(io, socket);
  });
}

module.exports = initSockets;
