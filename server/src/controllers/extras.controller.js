"use strict";

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { getMembership } = require("./room.controller");

/* ============================== Starred messages ============================== */

function starMessage(req, res) {
  const { messageId } = req.params;
  const msg = db.prepare("SELECT room_id FROM messages WHERE id = ?").get(messageId);
  if (!msg) return res.status(404).json({ error: "Message not found." });
  if (!getMembership(msg.room_id, req.user.id)) return res.status(403).json({ error: "Not a member of this room." });

  db.prepare("INSERT OR IGNORE INTO starred_messages (user_id, message_id) VALUES (?, ?)").run(req.user.id, messageId);
  res.status(201).json({ ok: true });
}

function unstarMessage(req, res) {
  db.prepare("DELETE FROM starred_messages WHERE user_id = ? AND message_id = ?").run(req.user.id, req.params.messageId);
  res.json({ ok: true });
}

function getStarredMessages(req, res) {
  const rows = db
    .prepare(
      `SELECT m.id, m.room_id, m.sender_name, m.type, m.content, m.file_name, m.created_at, r.name AS room_name
       FROM starred_messages s
       JOIN messages m ON m.id = s.message_id
       JOIN rooms r ON r.id = m.room_id
       WHERE s.user_id = ? AND m.deleted_at IS NULL
       ORDER BY s.created_at DESC LIMIT 200`
    )
    .all(req.user.id);

  res.json({
    starred: rows.map((m) => ({
      id: m.id,
      roomId: m.room_id,
      roomName: m.room_name,
      senderName: m.sender_name,
      type: m.type,
      content: m.content,
      fileName: m.file_name,
      createdAt: m.created_at,
    })),
  });
}

/* ============================== Blocked users ============================== */

function blockUser(req, res) {
  const { userId } = req.params;
  if (userId === req.user.id) return res.status(400).json({ error: "You can't block yourself." });
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!target) return res.status(404).json({ error: "That user doesn't exist." });
  db.prepare("INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)").run(req.user.id, userId);
  res.status(201).json({ ok: true });
}

function unblockUser(req, res) {
  db.prepare("DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?").run(req.user.id, req.params.userId);
  res.json({ ok: true });
}

function getBlockedUsers(req, res) {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_url FROM blocked_users b
       JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?`
    )
    .all(req.user.id);
  res.json({ blocked: rows.map((u) => ({ id: u.id, username: u.username, avatarUrl: u.avatar_url })) });
}

/* ============================== Room mutes ============================== */

function setMute(req, res) {
  const { roomId } = req.params;
  const { muted } = req.body || {};
  if (!getMembership(roomId, req.user.id)) return res.status(403).json({ error: "Not a member of this room." });

  if (muted) {
    db.prepare("INSERT OR IGNORE INTO room_mutes (user_id, room_id) VALUES (?, ?)").run(req.user.id, roomId);
  } else {
    db.prepare("DELETE FROM room_mutes WHERE user_id = ? AND room_id = ?").run(req.user.id, roomId);
  }
  res.json({ ok: true, muted: !!muted });
}

/* ============================== Reports ============================== */

function createReport(req, res) {
  const { targetUserId, messageId, reason } = req.body || {};
  if (typeof reason !== "string" || reason.trim().length < 3) {
    return res.status(400).json({ error: "Please describe the issue (at least 3 characters)." });
  }
  if (!targetUserId && !messageId) {
    return res.status(400).json({ error: "A report needs a target user or message." });
  }

  if (targetUserId) {
    const targetUser = db.prepare("SELECT id FROM users WHERE id = ?").get(targetUserId);
    if (!targetUser) return res.status(404).json({ error: "That user doesn't exist." });
  }

  let messageRoomId = null;
  if (messageId) {
    const msg = db.prepare("SELECT id, room_id FROM messages WHERE id = ?").get(messageId);
    if (!msg) return res.status(404).json({ error: "That message doesn't exist." });
    // The reporter must actually be able to see the message they're reporting.
    if (!getMembership(msg.room_id, req.user.id)) {
      return res.status(403).json({ error: "You don't have access to that message." });
    }
    messageRoomId = msg.room_id;
  }

  db.prepare(
    "INSERT INTO reports (id, reporter_id, target_user_id, message_id, reason) VALUES (?, ?, ?, ?, ?)"
  ).run(uuidv4(), req.user.id, targetUserId || null, messageId || null, reason.trim().slice(0, 500));

  res.status(201).json({ ok: true, roomId: messageRoomId });
}

/* ============================== Call history ============================== */

function getCallHistory(req, res) {
  const rows = db
    .prepare(
      `SELECT c.*, 
        caller.username AS caller_name, callee.username AS callee_name, r.name AS room_name
       FROM call_logs c
       LEFT JOIN users caller ON caller.id = c.caller_id
       LEFT JOIN users callee ON callee.id = c.callee_id
       LEFT JOIN rooms r ON r.id = c.room_id
       WHERE c.caller_id = ? OR c.callee_id = ?
       ORDER BY c.started_at DESC LIMIT 100`
    )
    .all(req.user.id, req.user.id);

  res.json({
    calls: rows.map((c) => ({
      id: c.id,
      roomId: c.room_id,
      roomName: c.room_name,
      callType: c.call_type,
      status: c.status,
      direction: c.caller_id === req.user.id ? "outgoing" : "incoming",
      peerName: c.caller_id === req.user.id ? c.callee_name : c.caller_name,
      startedAt: c.started_at * 1000,
      durationSec: c.duration_sec,
    })),
  });
}

module.exports = {
  starMessage,
  unstarMessage,
  getStarredMessages,
  blockUser,
  unblockUser,
  getBlockedUsers,
  setMute,
  createReport,
  getCallHistory,
};
