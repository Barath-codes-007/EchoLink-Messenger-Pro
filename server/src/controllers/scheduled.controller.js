"use strict";

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const config = require("../config");
const { sanitizeText } = require("../utils/sanitize");
const { getMembership } = require("./room.controller");

function scheduleMessage(req, res) {
  const { roomId, content, sendAt } = req.body || {};
  const membership = getMembership(roomId, req.user.id);
  if (!membership) return res.status(403).json({ error: "Not a member of this room." });
  if (membership.muted) return res.status(403).json({ error: "You are muted in this room." });

  const clean = sanitizeText(content, config.maxMessageLength);
  if (!clean) return res.status(400).json({ error: "Message cannot be empty." });

  const sendAtMs = parseInt(sendAt, 10);
  if (!sendAtMs || sendAtMs <= Date.now()) {
    return res.status(400).json({ error: "Scheduled time must be in the future." });
  }
  if (sendAtMs > Date.now() + 30 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: "Can't schedule more than 30 days out." });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO scheduled_messages (id, room_id, sender_id, sender_name, type, content, send_at, created_at)
     VALUES (?, ?, ?, ?, 'text', ?, ?, ?)`
  ).run(id, roomId, req.user.id, req.user.username, clean, sendAtMs, Date.now());

  res.status(201).json({ scheduled: { id, roomId, content: clean, sendAt: sendAtMs } });
}

function getScheduledMessages(req, res) {
  const roomId = req.params.roomId;
  if (!getMembership(roomId, req.user.id)) return res.status(403).json({ error: "Not a member of this room." });

  const rows = db
    .prepare(
      `SELECT id, room_id, sender_id, sender_name, content, send_at FROM scheduled_messages
       WHERE room_id = ? AND sent = 0 AND sender_id = ? ORDER BY send_at ASC`
    )
    .all(roomId, req.user.id);

  res.json({ scheduled: rows.map((r) => ({ id: r.id, roomId: r.room_id, senderName: r.sender_name, content: r.content, sendAt: r.send_at })) });
}

function cancelScheduledMessage(req, res) {
  const row = db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Scheduled message not found." });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: "Not your scheduled message." });
  if (row.sent) return res.status(400).json({ error: "This message has already been sent." });

  db.prepare("DELETE FROM scheduled_messages WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
}

module.exports = { scheduleMessage, getScheduledMessages, cancelScheduledMessage };
