"use strict";

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { endCallsForRoom } = require("../sockets/calls");
const { endGroupCallsForRoom } = require("../sockets/group-calls");

/** Deletes any temporary room whose expiry has passed, notifying members
 * currently connected to it so their UI can react (leave the view, drop it
 * from the sidebar) instead of silently going stale. */
function sweepExpiredRooms(io) {
  const expired = db
    .prepare("SELECT id, name FROM rooms WHERE type = 'temporary' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(Date.now());

  for (const room of expired) {
    db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
    endCallsForRoom(io, room.id);
    endGroupCallsForRoom(io, room.id);
    io.to(room.id).emit("room:deleted", { roomId: room.id, reason: "expired" });
  }
  return expired.length;
}

/** Finds due scheduled messages, inserts them as real messages, and
 * broadcasts them exactly like a live send would. */
function sweepScheduledMessages(io) {
  const due = db.prepare("SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?").all(Date.now());

  for (const row of due) {
    const messageId = uuidv4();
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO messages (id, room_id, sender_id, sender_name, type, content, created_at) VALUES (?, ?, ?, ?, 'text', ?, ?)`
    ).run(messageId, row.room_id, row.sender_id, row.sender_name, row.content, createdAt);
    db.prepare("UPDATE scheduled_messages SET sent = 1 WHERE id = ?").run(row.id);

    const saved = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    io.to(row.room_id).emit("message:new", {
      id: saved.id,
      roomId: saved.room_id,
      senderId: saved.sender_id,
      senderName: saved.sender_name,
      type: saved.type,
      content: saved.content,
      fileName: null,
      fileSize: null,
      fileType: null,
      replyToId: null,
      editedAt: null,
      deletedAt: null,
      pinned: false,
      forwardedFrom: null,
      mentions: [],
      locationLiveUntil: null,
      createdAt: saved.created_at,
      reactions: [],
      replyCount: 0,
    });
  }
  return due.length;
}

function startExpirySweep(io, intervalMs = 15000) {
  const timer = setInterval(() => {
    sweepExpiredRooms(io);
    sweepScheduledMessages(io);
  }, intervalMs);
  if (timer.unref) timer.unref(); // don't keep the process alive just for this
  return timer;
}

/** Called on logout: deletes any temporary room this user owns that was
 * created with "delete when I log out" enabled. */
function deleteOwnerLogoutRooms(io, userId) {
  const rooms = db
    .prepare(
      "SELECT id FROM rooms WHERE type = 'temporary' AND delete_on_owner_logout = 1 AND owner_id = ?"
    )
    .all(userId);

  for (const room of rooms) {
    db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
    endCallsForRoom(io, room.id);
    endGroupCallsForRoom(io, room.id);
    io.to(room.id).emit("room:deleted", { roomId: room.id, reason: "owner-logged-out" });
  }
  return rooms.length;
}

module.exports = { sweepExpiredRooms, sweepScheduledMessages, startExpirySweep, deleteOwnerLogoutRooms };
