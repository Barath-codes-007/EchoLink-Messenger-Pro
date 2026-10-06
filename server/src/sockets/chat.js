"use strict";

const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const config = require("../config");
const { sanitizeText, extractMentions } = require("../utils/sanitize");
const { getMembership } = require("../controllers/room.controller");
const { allow } = require("../utils/socketRateLimit");

// userId -> roomId, tracked purely so a socket that disconnects mid-recording
// (crash, tab close, connection loss) doesn't leave other room members
// staring at a "X is recording…" indicator that never clears — see the
// disconnect handler below.
const activeRecordings = new Map();

function toWireMessage(m, extra = {}) {
  return {
    id: m.id,
    roomId: m.room_id,
    senderId: m.sender_id,
    senderName: m.sender_name,
    type: m.type,
    content: m.content,
    fileName: m.file_name,
    fileSize: m.file_size,
    fileType: m.file_type,
    replyToId: m.reply_to_id,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    pinned: !!m.pinned,
    forwardedFrom: m.forwarded_from,
    mentions: m.mentions ? JSON.parse(m.mentions) : [],
    locationLiveUntil: m.location_live_until,
    createdAt: m.created_at,
    reactions: [],
    replyCount: 0,
    ...extra,
  };
}

function requireMembership(roomId, userId) {
  const membership = getMembership(roomId, userId);
  if (!membership || membership.banned) return null;
  return membership;
}

function roomMemberUsernames(roomId) {
  return db
    .prepare(`SELECT u.username FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?`)
    .all(roomId)
    .map((r) => r.username);
}

function attachPollPayload(wire, messageId) {
  const poll = db.prepare("SELECT * FROM polls WHERE message_id = ?").get(messageId);
  if (!poll) return wire;
  const options = JSON.parse(poll.options);
  const votes = db.prepare("SELECT user_id, option_index FROM poll_votes WHERE poll_id = ?").all(poll.id);
  const tally = options.map((_, i) => votes.filter((v) => v.option_index === i).length);
  return {
    ...wire,
    poll: {
      id: poll.id,
      question: poll.question,
      options,
      allowMultiple: !!poll.allow_multiple,
      closed: !!poll.closed,
      createdBy: poll.created_by,
      tally,
      totalVotes: votes.length,
      myVotes: votes.filter((v) => v.user_id === wire.__requesterId).map((v) => v.option_index),
    },
  };
}

function registerChatHandlers(io, socket) {
  const user = socket.data.user;

  socket.on("message:send", (payload, ack) => {
    if (!allow(`msg:${user.id}`, 30, 10_000)) {
      return ack?.({ ok: false, error: "You're sending messages too fast. Slow down a bit." });
    }
    const { roomId, type, content, fileName, fileSize, fileType, replyToId, forwardedFrom } = payload || {};
    const membership = requireMembership(roomId, user.id);
    if (!membership) return ack?.({ ok: false, error: "Not a member of this room." });
    if (membership.muted) return ack?.({ ok: false, error: "You are muted in this room." });

    const validTypes = ["text", "image", "file", "audio", "video", "announcement", "gif"];
    if (!validTypes.includes(type)) return ack?.({ ok: false, error: "Invalid message type." });

    if (type === "announcement" && !["owner", "admin"].includes(membership.role)) {
      return ack?.({ ok: false, error: "Only owners and admins can post announcements." });
    }

    // A reply must point at a message that actually exists in *this* room —
    // otherwise a client could forge a replyToId belonging to a message in a
    // room the sender isn't even a member of.
    let cleanReplyToId = null;
    if (replyToId) {
      const target = db.prepare("SELECT id FROM messages WHERE id = ? AND room_id = ?").get(replyToId, roomId);
      if (!target) return ack?.({ ok: false, error: "The message being replied to isn't in this room." });
      cleanReplyToId = replyToId;
    }

    let cleanContent;
    let mentions = [];
    let uploadRecord = null;
    if (type === "text" || type === "announcement") {
      cleanContent = sanitizeText(content, config.maxMessageLength);
      if (!cleanContent) return ack?.({ ok: false, error: "Message cannot be empty." });
      mentions = extractMentions(cleanContent, roomMemberUsernames(roomId)).filter((u) => u !== user.username);
    } else if (type === "gif") {
      if (typeof content !== "string" || !/^https:\/\//.test(content)) {
        return ack?.({ ok: false, error: "Invalid GIF reference." });
      }
      cleanContent = content;
    } else {
      // For media types, `content` is the /api/files/... URL returned by the
      // REST upload endpoint — never raw file data over the socket. Resolve
      // it back to its uploads row and make sure *this* sender actually
      // owns that upload and hasn't already attached it to another message.
      if (typeof content !== "string" || !content.startsWith("/api/files/")) {
        return ack?.({ ok: false, error: "Invalid attachment reference." });
      }
      const filename = content.slice("/api/files/".length);
      uploadRecord = db.prepare("SELECT * FROM uploads WHERE filename = ?").get(filename);
      if (!uploadRecord || uploadRecord.user_id !== user.id || uploadRecord.message_id) {
        return ack?.({ ok: false, error: "Invalid attachment reference." });
      }
      cleanContent = content;
    }

    const forwardedLabel = forwardedFrom ? sanitizeText(String(forwardedFrom), 40) : null;
    const mentionsJson = mentions.length ? JSON.stringify(mentions) : null;

    const id = uuidv4();
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO messages (id, room_id, sender_id, sender_name, type, content, file_name, file_size, file_type, reply_to_id, forwarded_from, mentions, pinned, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      roomId,
      user.id,
      user.username,
      type === "announcement" ? "announcement" : type,
      cleanContent,
      fileName ? String(fileName).slice(0, 150) : null,
      typeof fileSize === "number" ? fileSize : null,
      fileType ? String(fileType).slice(0, 100) : null,
      cleanReplyToId,
      forwardedLabel,
      mentionsJson,
      type === "announcement" ? 1 : 0, // announcements auto-pin
      createdAt
    );

    if (uploadRecord) {
      db.prepare("UPDATE uploads SET room_id = ?, message_id = ? WHERE id = ?").run(roomId, id, uploadRecord.id);
    }

    const saved = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    const wire = toWireMessage(saved);
    io.to(roomId).emit("message:new", wire);
    ack?.({ ok: true, message: wire });
  });

  socket.on("message:edit", ({ roomId, messageId, content }, ack) => {
    const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ?").get(messageId, roomId);
    if (!msg || msg.sender_id !== user.id) return ack?.({ ok: false, error: "Cannot edit this message." });
    if (!["text", "announcement"].includes(msg.type)) return ack?.({ ok: false, error: "Only text messages can be edited." });

    const clean = sanitizeText(content, config.maxMessageLength);
    if (!clean) return ack?.({ ok: false, error: "Message cannot be empty." });

    const mentions = extractMentions(clean, roomMemberUsernames(roomId)).filter((u) => u !== user.username);
    const mentionsJson = mentions.length ? JSON.stringify(mentions) : null;

    db.prepare("UPDATE messages SET content = ?, edited_at = ?, mentions = ? WHERE id = ?").run(clean, Date.now(), mentionsJson, messageId);
    io.to(roomId).emit("message:edited", { id: messageId, content: clean, editedAt: Date.now(), mentions });
    ack?.({ ok: true });
  });

  socket.on("message:delete", ({ roomId, messageId }, ack) => {
    const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ?").get(messageId, roomId);
    if (!msg) return ack?.({ ok: false, error: "Message not found." });

    const membership = requireMembership(roomId, user.id);
    const canModerate = membership && ["owner", "admin"].includes(membership.role);
    if (msg.sender_id !== user.id && !canModerate) {
      return ack?.({ ok: false, error: "You cannot delete this message." });
    }

    db.prepare("UPDATE messages SET deleted_at = ?, content = '' WHERE id = ?").run(Date.now(), messageId);
    io.to(roomId).emit("message:deleted", { id: messageId });
    ack?.({ ok: true });
  });

  socket.on("message:pin", ({ roomId, messageId, pinned }, ack) => {
    const membership = requireMembership(roomId, user.id);
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return ack?.({ ok: false, error: "Only admins can pin messages." });
    }
    db.prepare("UPDATE messages SET pinned = ? WHERE id = ? AND room_id = ?").run(pinned ? 1 : 0, messageId, roomId);
    io.to(roomId).emit("message:pinned", { id: messageId, pinned: !!pinned });
    ack?.({ ok: true });
  });

  socket.on("message:react", ({ roomId, messageId, emoji }, ack) => {
    if (!allow(`react:${user.id}`, 60, 10_000)) return ack?.({ ok: false, error: "Too many reactions — slow down a bit." });
    if (!requireMembership(roomId, user.id)) return ack?.({ ok: false, error: "Not a member of this room." });
    if (typeof emoji !== "string" || emoji.length > 8) return ack?.({ ok: false, error: "Invalid reaction." });

    // The message must actually belong to this room — otherwise a client
    // could react to any messageId from a different room it isn't a member
    // of, just by supplying a roomId it does belong to.
    const target = db.prepare("SELECT id FROM messages WHERE id = ? AND room_id = ?").get(messageId, roomId);
    if (!target) return ack?.({ ok: false, error: "Message not found in this room." });

    const existing = db
      .prepare("SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
      .get(messageId, user.id, emoji);

    if (existing) {
      db.prepare("DELETE FROM message_reactions WHERE id = ?").run(existing.id);
      io.to(roomId).emit("message:reaction", { messageId, userId: user.id, emoji, removed: true });
    } else {
      db.prepare("INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)").run(
        uuidv4(),
        messageId,
        user.id,
        emoji
      );
      io.to(roomId).emit("message:reaction", { messageId, userId: user.id, emoji, removed: false });
    }
    ack?.({ ok: true });
  });

  socket.on("typing", ({ roomId, isTyping }) => {
    if (!requireMembership(roomId, user.id)) return;
    socket.to(roomId).emit("typing", { userId: user.id, username: user.username, isTyping: !!isTyping });
  });

  // Lets other room members see "X is recording a voice message…" while
  // it's happening, rather than only finding out once the upload finishes
  // and the message appears.
  socket.on("voice:recording", ({ roomId, isRecording, status }) => {
    if (!requireMembership(roomId, user.id)) return;
    const cleanStatus = status === "uploading" ? "uploading" : "recording";
    if (isRecording) activeRecordings.set(user.id, roomId);
    else activeRecordings.delete(user.id);
    socket.to(roomId).emit("voice:recording", { userId: user.id, username: user.username, isRecording: !!isRecording, status: cleanStatus });
  });

  socket.on("disconnect", () => {
    const roomId = activeRecordings.get(user.id);
    if (roomId) {
      activeRecordings.delete(user.id);
      socket.to(roomId).emit("voice:recording", { userId: user.id, username: user.username, isRecording: false });
    }
  });

  socket.on("message:read", ({ roomId }) => {
    if (!requireMembership(roomId, user.id)) return;
    const now = Date.now();
    db.prepare("UPDATE room_members SET last_read_at = ? WHERE room_id = ? AND user_id = ?").run(
      Math.floor(now / 1000),
      roomId,
      user.id
    );
    socket.to(roomId).emit("message:seen", { roomId, userId: user.id, at: now });
  });

  /* ============================== Threads ============================== */

  socket.on("thread:get", ({ roomId, rootMessageId }, ack) => {
    if (!requireMembership(roomId, user.id)) return ack?.({ ok: false, error: "Not a member of this room." });
    const replies = db
      .prepare(
        `SELECT m.*, (SELECT json_group_array(json_object('emoji', r.emoji, 'userId', r.user_id)) FROM message_reactions r WHERE r.message_id = m.id) AS reactions_json
         FROM messages m WHERE m.reply_to_id = ? AND m.room_id = ? ORDER BY m.created_at ASC`
      )
      .all(rootMessageId, roomId);

    ack?.({
      ok: true,
      replies: replies.map((m) => ({ ...toWireMessage(m), reactions: JSON.parse(m.reactions_json || "[]") })),
    });
  });

  /* ============================== Polls ============================== */

  socket.on("poll:create", ({ roomId, question, options, allowMultiple }, ack) => {
    const membership = requireMembership(roomId, user.id);
    if (!membership) return ack?.({ ok: false, error: "Not a member of this room." });
    if (membership.muted) return ack?.({ ok: false, error: "You are muted in this room." });

    const cleanQuestion = sanitizeText(question, 200);
    if (!cleanQuestion) return ack?.({ ok: false, error: "Poll question is required." });

    const cleanOptions = (Array.isArray(options) ? options : [])
      .map((o) => sanitizeText(String(o), 80))
      .filter(Boolean)
      .slice(0, 10);
    if (cleanOptions.length < 2) return ack?.({ ok: false, error: "A poll needs at least 2 options." });

    const messageId = uuidv4();
    const pollId = uuidv4();
    const createdAt = Date.now();

    db.prepare(
      `INSERT INTO messages (id, room_id, sender_id, sender_name, type, content, created_at) VALUES (?, ?, ?, ?, 'poll', ?, ?)`
    ).run(messageId, roomId, user.id, user.username, cleanQuestion, createdAt);

    db.prepare(
      `INSERT INTO polls (id, message_id, room_id, question, options, allow_multiple, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(pollId, messageId, roomId, cleanQuestion, JSON.stringify(cleanOptions), allowMultiple ? 1 : 0, user.id, createdAt);

    const saved = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    const wire = { ...toWireMessage(saved), __requesterId: user.id };
    const withPoll = attachPollPayload(wire, messageId);
    delete withPoll.__requesterId;

    io.to(roomId).emit("message:new", withPoll);
    ack?.({ ok: true, message: withPoll });
  });

  socket.on("poll:vote", ({ roomId, pollId, optionIndex }, ack) => {
    if (!requireMembership(roomId, user.id)) return ack?.({ ok: false, error: "Not a member of this room." });
    const poll = db.prepare("SELECT * FROM polls WHERE id = ? AND room_id = ?").get(pollId, roomId);
    if (!poll) return ack?.({ ok: false, error: "Poll not found." });
    if (poll.closed) return ack?.({ ok: false, error: "This poll is closed." });

    const options = JSON.parse(poll.options);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      return ack?.({ ok: false, error: "Invalid option." });
    }

    if (!poll.allow_multiple) {
      db.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?").run(pollId, user.id);
      db.prepare("INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)").run(pollId, user.id, optionIndex);
    } else {
      const existing = db.prepare("SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?").get(pollId, user.id, optionIndex);
      if (existing) db.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?").run(pollId, user.id, optionIndex);
      else db.prepare("INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)").run(pollId, user.id, optionIndex);
    }

    const votes = db.prepare("SELECT user_id, option_index FROM poll_votes WHERE poll_id = ?").all(pollId);
    const tally = options.map((_, i) => votes.filter((v) => v.option_index === i).length);
    io.to(roomId).emit("poll:updated", { pollId, tally, totalVotes: votes.length });
    ack?.({ ok: true, tally, myVotes: votes.filter((v) => v.user_id === user.id).map((v) => v.option_index) });
  });

  socket.on("poll:close", ({ roomId, pollId }, ack) => {
    const poll = db.prepare("SELECT * FROM polls WHERE id = ? AND room_id = ?").get(pollId, roomId);
    if (!poll) return ack?.({ ok: false, error: "Poll not found." });
    const membership = requireMembership(roomId, user.id);
    if (poll.created_by !== user.id && !["owner", "admin"].includes(membership?.role)) {
      return ack?.({ ok: false, error: "Only the poll creator or an admin can close it." });
    }
    db.prepare("UPDATE polls SET closed = 1 WHERE id = ?").run(pollId);
    io.to(roomId).emit("poll:closed", { pollId });
    ack?.({ ok: true });
  });

  /* ============================== Live location ============================== */

  socket.on("location:share", ({ roomId, lat, lng, liveMinutes }, ack) => {
    const membership = requireMembership(roomId, user.id);
    if (!membership) return ack?.({ ok: false, error: "Not a member of this room." });
    if (membership.muted) return ack?.({ ok: false, error: "You are muted in this room." });
    const validCoord = (v) => typeof v === "number" && Number.isFinite(v);
    if (!validCoord(lat) || !validCoord(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return ack?.({ ok: false, error: "Invalid coordinates." });
    }

    const liveUntil = liveMinutes > 0 ? Date.now() + Math.min(liveMinutes, 480) * 60000 : null;
    const id = uuidv4();
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO messages (id, room_id, sender_id, sender_name, type, content, location_live_until, created_at)
       VALUES (?, ?, ?, ?, 'location', ?, ?, ?)`
    ).run(id, roomId, user.id, user.username, JSON.stringify({ lat, lng }), liveUntil, createdAt);

    const saved = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    const wire = toWireMessage(saved);
    io.to(roomId).emit("message:new", wire);
    ack?.({ ok: true, message: wire });
  });

  socket.on("location:update", ({ roomId, messageId, lat, lng }, ack) => {
    const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ? AND type = 'location'").get(messageId, roomId);
    if (!msg) return ack?.({ ok: false, error: "Location message not found." });
    if (msg.sender_id !== user.id) return ack?.({ ok: false, error: "Not your live location." });
    if (!msg.location_live_until || msg.location_live_until < Date.now()) return ack?.({ ok: false, error: "Live sharing has ended." });

    const validCoord = (v) => typeof v === "number" && Number.isFinite(v);
    if (!validCoord(lat) || !validCoord(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return ack?.({ ok: false, error: "Invalid coordinates." });
    }

    db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(JSON.stringify({ lat, lng }), messageId);
    io.to(roomId).emit("location:updated", { messageId, lat, lng });
    ack?.({ ok: true });
  });

  socket.on("location:stop", ({ roomId, messageId }, ack) => {
    const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ?").get(messageId, roomId);
    if (!msg || msg.sender_id !== user.id) return ack?.({ ok: false, error: "Not your live location." });
    db.prepare("UPDATE messages SET location_live_until = NULL WHERE id = ?").run(messageId);
    io.to(roomId).emit("location:stopped", { messageId });
    ack?.({ ok: true });
  });
}

module.exports = registerChatHandlers;
