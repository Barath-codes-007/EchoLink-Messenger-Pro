"use strict";

const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const config = require("../config");
const { generateUniqueRoomCode } = require("../services/roomCode");
const { isValidRoomName } = require("../utils/validators");
const { sanitizeText } = require("../utils/sanitize");

function roomSummary(room, memberCount) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    description: room.description,
    type: room.type,
    iconUrl: room.icon_url,
    ownerId: room.owner_id,
    hasPassword: !!room.password_hash,
    memberCount,
    expiresAt: room.expires_at,
    deleteOnOwnerLogout: !!room.delete_on_owner_logout,
    requireApproval: !!room.require_approval,
    createdAt: room.created_at,
  };
}

function getMemberCount(roomId) {
  return db.prepare("SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?").get(roomId).c;
}

function getMembership(roomId, userId) {
  return db.prepare("SELECT * FROM room_members WHERE room_id = ? AND user_id = ?").get(roomId, userId);
}

/** List rooms the current user belongs to. */
function myRooms(req, res) {
  const rows = db
    .prepare(
      `SELECT r.*, m.role FROM rooms r
       JOIN room_members m ON m.room_id = r.id
       WHERE m.user_id = ? AND m.banned = 0
       ORDER BY r.created_at DESC`
    )
    .all(req.user.id);

  const mutedRoomIds = new Set(
    db.prepare("SELECT room_id FROM room_mutes WHERE user_id = ?").all(req.user.id).map((r) => r.room_id)
  );

  res.json({
    rooms: rows.map((r) => ({ ...roomSummary(r, getMemberCount(r.id)), myRole: r.role, mutedByMe: mutedRoomIds.has(r.id) })),
  });
}

const CODE_RE = /^[A-Za-z0-9]{4,10}$/;

function createRoom(req, res) {
  const { name, description, type, password, code, expiresInSeconds, deleteOnOwnerLogout } = req.body || {};

  if (!isValidRoomName(name)) {
    return res.status(400).json({ error: "Room name must be 1-60 characters." });
  }
  if (!["temporary", "permanent"].includes(type)) {
    return res.status(400).json({ error: "Room type must be temporary or permanent." });
  }

  let finalCode;
  if (code) {
    const trimmed = String(code).trim().toUpperCase();
    if (!CODE_RE.test(trimmed)) {
      return res.status(400).json({ error: "Custom room codes must be 4-10 letters/numbers." });
    }
    const taken = db.prepare("SELECT 1 FROM rooms WHERE code = ? COLLATE NOCASE").get(trimmed);
    if (taken) {
      return res.status(409).json({ error: `Room code "${trimmed}" is already taken. Try another or generate one.` });
    }
    finalCode = trimmed;
  } else {
    finalCode = generateUniqueRoomCode();
  }

  let expiresAt = null;
  let deleteOnLogout = 0;
  if (type === "temporary") {
    if (typeof expiresInSeconds === "number" && expiresInSeconds > 0) {
      if (expiresInSeconds > 30 * 24 * 3600) {
        return res.status(400).json({ error: "Expiry can't be more than 30 days out." });
      }
      expiresAt = Date.now() + expiresInSeconds * 1000;
    }
    deleteOnLogout = deleteOnOwnerLogout ? 1 : 0;
  }

  const id = uuidv4();
  const passwordHash = password && typeof password === "string" ? bcrypt.hashSync(password, 10) : null;

  db.prepare(
    `INSERT INTO rooms (id, code, name, description, type, owner_id, password_hash, expires_at, delete_on_owner_logout, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`
  ).run(id, finalCode, name.trim(), sanitizeText(description || "", 200), type, req.user.id, passwordHash, expiresAt, deleteOnLogout);

  db.prepare(
    `INSERT INTO room_members (room_id, user_id, role, joined_at, last_read_at)
     VALUES (?, ?, 'owner', strftime('%s','now'), strftime('%s','now'))`
  ).run(id, req.user.id);

  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
  res.status(201).json({ room: { ...roomSummary(room, 1), myRole: "owner" } });
}

function joinRoom(req, res) {
  const { code, password } = req.body || {};
  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "Room code is required." });
  }

  const room = db.prepare("SELECT * FROM rooms WHERE code = ? COLLATE NOCASE").get(code.trim());
  if (!room) return res.status(404).json({ error: "No room found with that code." });

  const existingMembership = getMembership(room.id, req.user.id);
  if (existingMembership?.banned) {
    return res.status(403).json({ error: "You have been banned from this room." });
  }

  if (room.password_hash && !bcrypt.compareSync(password || "", room.password_hash)) {
    return res.status(401).json({ error: "Incorrect room password." });
  }

  const cap = room.type === "permanent" ? config.maxPermanentRoomSize : config.maxTempRoomSize;
  if (!existingMembership && getMemberCount(room.id) >= cap) {
    return res.status(403).json({ error: `This room is full (max ${cap} members).` });
  }

  if (!existingMembership && room.require_approval) {
    const alreadyPending = db.prepare("SELECT 1 FROM pending_join_requests WHERE room_id = ? AND user_id = ?").get(room.id, req.user.id);
    if (!alreadyPending) {
      db.prepare("INSERT INTO pending_join_requests (room_id, user_id) VALUES (?, ?)").run(room.id, req.user.id);
      const io = req.app.get("io");
      if (io) {
        const admins = db
          .prepare(`SELECT user_id FROM room_members WHERE room_id = ? AND role IN ('owner','admin')`)
          .all(room.id);
        for (const a of admins) {
          io.to(`user:${a.user_id}`).emit("room:join-request", {
            roomId: room.id,
            roomName: room.name,
            userId: req.user.id,
            username: req.user.username,
          });
        }
      }
    }
    return res.status(202).json({ pending: true, message: "This room requires approval to join. Your request has been sent." });
  }

  if (!existingMembership) {
    db.prepare(
      `INSERT INTO room_members (room_id, user_id, role, joined_at, last_read_at)
       VALUES (?, ?, 'member', strftime('%s','now'), strftime('%s','now'))`
    ).run(room.id, req.user.id);
  }

  const membership = getMembership(room.id, req.user.id);
  res.json({ room: { ...roomSummary(room, getMemberCount(room.id)), myRole: membership.role } });
}

function getPendingRequests(req, res) {
  const roomId = req.params.roomId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only owners and admins can view pending requests." });
  }
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_url, p.requested_at
       FROM pending_join_requests p JOIN users u ON u.id = p.user_id
       WHERE p.room_id = ? ORDER BY p.requested_at ASC`
    )
    .all(roomId);
  res.json({ pending: rows });
}

function approvePendingRequest(req, res) {
  const roomId = req.params.roomId;
  const targetUserId = req.params.userId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only owners and admins can approve requests." });
  }
  const pending = db.prepare("SELECT 1 FROM pending_join_requests WHERE room_id = ? AND user_id = ?").get(roomId, targetUserId);
  if (!pending) return res.status(404).json({ error: "No pending request from that user." });

  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found." });

  // Capacity was checked when the request was first queued, but other
  // members may have joined since then — re-check it now, right before
  // insertion, so approving a request can never push the room over its cap.
  // better-sqlite3 runs synchronously and Node is single-threaded, so
  // wrapping the check + insert in one function body (no intervening
  // await) is already atomic with respect to other requests in this process.
  const cap = room.type === "permanent" ? config.maxPermanentRoomSize : config.maxTempRoomSize;
  const alreadyMember = getMembership(roomId, targetUserId);
  if (!alreadyMember && getMemberCount(roomId) >= cap) {
    return res.status(403).json({ error: `This room is now full (max ${cap} members). The request was not approved.` });
  }

  db.prepare("DELETE FROM pending_join_requests WHERE room_id = ? AND user_id = ?").run(roomId, targetUserId);
  db.prepare(
    `INSERT OR IGNORE INTO room_members (room_id, user_id, role, joined_at, last_read_at)
     VALUES (?, ?, 'member', strftime('%s','now'), strftime('%s','now'))`
  ).run(roomId, targetUserId);

  const io = req.app.get("io");
  io?.to(`user:${targetUserId}`).emit("room:join-approved", { roomId });
  res.json({ ok: true });
}

function rejectPendingRequest(req, res) {
  const roomId = req.params.roomId;
  const targetUserId = req.params.userId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only owners and admins can reject requests." });
  }
  db.prepare("DELETE FROM pending_join_requests WHERE room_id = ? AND user_id = ?").run(roomId, targetUserId);

  const io = req.app.get("io");
  io?.to(`user:${targetUserId}`).emit("room:join-rejected", { roomId });
  res.json({ ok: true });
}

function getRoom(req, res) {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found." });

  const membership = getMembership(room.id, req.user.id);
  if (!membership || membership.banned) return res.status(403).json({ error: "You are not a member of this room." });

  res.json({ room: { ...roomSummary(room, getMemberCount(room.id)), myRole: membership.role } });
}

function getMembers(req, res) {
  const membership = getMembership(req.params.roomId, req.user.id);
  if (!membership) return res.status(403).json({ error: "Not a member of this room." });

  const members = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_url, u.status, u.last_seen_at, m.role, m.muted, m.banned, m.joined_at, m.last_read_at
       FROM room_members m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ? ORDER BY m.joined_at ASC`
    )
    .all(req.params.roomId);

  res.json({ members: members.map((m) => ({ ...m, last_read_at: m.last_read_at * 1000 })) });
}

function leaveRoom(req, res) {
  const roomId = req.params.roomId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership) return res.status(404).json({ error: "You are not in this room." });

  db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, req.user.id);

  const remaining = getMemberCount(roomId);
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);

  if (remaining === 0) {
    // Temporary rooms vanish entirely once empty (matches original behavior).
    // Permanent rooms persist even with zero members until explicitly deleted.
    if (room && room.type === "temporary") {
      db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    }
  } else if (membership.role === "owner") {
    // Auto-transfer ownership to the longest-standing remaining member.
    // Both rooms.owner_id and room_members.role must be updated together —
    // leaving either one stale creates two conflicting sources of truth for
    // "who owns this room" (e.g. deleteRoom() only trusts room_members.role,
    // while other code may read rooms.owner_id directly).
    const next = db
      .prepare("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at ASC LIMIT 1")
      .get(roomId);
    if (next) {
      db.transaction(() => {
        db.prepare("UPDATE room_members SET role = 'owner' WHERE room_id = ? AND user_id = ?").run(roomId, next.user_id);
        db.prepare("UPDATE rooms SET owner_id = ? WHERE id = ?").run(next.user_id, roomId);
      })();
    }
  }

  res.json({ ok: true });
}

function deleteRoom(req, res) {
  const roomId = req.params.roomId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership || membership.role !== "owner") {
    return res.status(403).json({ error: "Only the room owner can delete this room." });
  }
  db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
  require("../services/roomEvents").emit("room:deleted", { roomId, reason: "deleted-by-owner" });
  res.json({ ok: true });
}

function updateRoom(req, res) {
  const roomId = req.params.roomId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only owners and admins can edit this room." });
  }

  const { name, description, iconUrl, password, requireApproval } = req.body || {};
  const fields = [];
  const values = [];

  if (name !== undefined) {
    if (!isValidRoomName(name)) return res.status(400).json({ error: "Invalid room name." });
    fields.push("name = ?");
    values.push(name.trim());
  }
  if (description !== undefined) {
    fields.push("description = ?");
    values.push(sanitizeText(description, 200));
  }
  if (iconUrl !== undefined) {
    fields.push("icon_url = ?");
    values.push(iconUrl);
  }
  if (password !== undefined) {
    fields.push("password_hash = ?");
    values.push(password ? bcrypt.hashSync(password, 10) : null);
  }
  if (requireApproval !== undefined) {
    fields.push("require_approval = ?");
    values.push(requireApproval ? 1 : 0);
  }

  if (fields.length === 0) return res.status(400).json({ error: "Nothing to update." });

  values.push(roomId);
  db.prepare(`UPDATE rooms SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
  res.json({ room: roomSummary(room, getMemberCount(roomId)) });
}

function transferOwnership(req, res) {
  const roomId = req.params.roomId;
  const { userId } = req.body || {};
  const membership = getMembership(roomId, req.user.id);
  if (!membership || membership.role !== "owner") {
    return res.status(403).json({ error: "Only the current owner can transfer ownership." });
  }
  const target = getMembership(roomId, userId);
  if (!target) return res.status(404).json({ error: "Target user is not a member of this room." });

  db.transaction(() => {
    db.prepare("UPDATE room_members SET role = 'member' WHERE room_id = ? AND user_id = ?").run(roomId, req.user.id);
    db.prepare("UPDATE room_members SET role = 'owner' WHERE room_id = ? AND user_id = ?").run(roomId, userId);
    db.prepare("UPDATE rooms SET owner_id = ? WHERE id = ?").run(userId, roomId);
  })();
  res.json({ ok: true });
}

function moderateMember(req, res) {
  const roomId = req.params.roomId;
  const { userId, action } = req.body || {}; // action: kick | ban | unban | mute | unmute | promote | demote
  const membership = getMembership(roomId, req.user.id);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only owners and admins can moderate members." });
  }
  const target = getMembership(roomId, userId);
  if (!target) return res.status(404).json({ error: "That user is not in this room." });
  if (target.role === "owner") return res.status(403).json({ error: "Cannot moderate the room owner." });

  switch (action) {
    case "kick":
      db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      break;
    case "ban":
      db.prepare("UPDATE room_members SET banned = 1 WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      break;
    case "unban":
      db.prepare("UPDATE room_members SET banned = 0 WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      break;
    case "mute":
      db.prepare("UPDATE room_members SET muted = 1 WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      break;
    case "unmute":
      db.prepare("UPDATE room_members SET muted = 0 WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      break;
    case "promote":
      db.prepare("UPDATE room_members SET role = 'admin' WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      break;
    case "demote":
      db.prepare("UPDATE room_members SET role = 'member' WHERE room_id = ? AND user_id = ?").run(roomId, userId);
      break;
    default:
      return res.status(400).json({ error: "Unknown moderation action." });
  }

  res.json({ ok: true });
}

/** Paginated message history for a room. */
function getMessages(req, res) {
  const roomId = req.params.roomId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership) return res.status(403).json({ error: "Not a member of this room." });

  const before = req.query.before ? parseInt(req.query.before, 10) : Date.now() + 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  const rows = db
    .prepare(
      `SELECT m.*, 
        (SELECT json_group_array(json_object('emoji', r.emoji, 'userId', r.user_id))
         FROM message_reactions r WHERE r.message_id = m.id) AS reactions_json,
        (SELECT COUNT(*) FROM messages replies WHERE replies.reply_to_id = m.id) AS reply_count
       FROM messages m
       WHERE m.room_id = ? AND m.created_at < ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(roomId, before, limit);

  const messages = rows
    .map((m) => {
      const base = {
        id: m.id,
        roomId: m.room_id,
        senderId: m.sender_id,
        senderName: m.sender_name,
        type: m.type,
        content: m.deleted_at ? "" : m.content,
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
        reactions: JSON.parse(m.reactions_json || "[]"),
        replyCount: m.reply_count,
      };

      if (m.type === "poll") {
        const poll = db.prepare("SELECT * FROM polls WHERE message_id = ?").get(m.id);
        if (poll) {
          const options = JSON.parse(poll.options);
          const votes = db.prepare("SELECT user_id, option_index FROM poll_votes WHERE poll_id = ?").all(poll.id);
          base.poll = {
            id: poll.id,
            question: poll.question,
            options,
            allowMultiple: !!poll.allow_multiple,
            closed: !!poll.closed,
            createdBy: poll.created_by,
            tally: options.map((_, i) => votes.filter((v) => v.option_index === i).length),
            totalVotes: votes.length,
            myVotes: votes.filter((v) => v.user_id === req.user.id).map((v) => v.option_index),
          };
        }
      }
      return base;
    })
    .reverse();

  db.prepare("UPDATE room_members SET last_read_at = strftime('%s','now') WHERE room_id = ? AND user_id = ?").run(
    roomId,
    req.user.id
  );

  res.json({ messages });
}

/** Full-text-ish search (SQL LIKE) across a room's non-deleted text messages. */
function searchMessages(req, res) {
  const roomId = req.params.roomId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership) return res.status(403).json({ error: "Not a member of this room." });

  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.status(400).json({ error: "Search query must be at least 2 characters." });

  const rows = db
    .prepare(
      `SELECT id, sender_name, sender_id, type, content, created_at
       FROM messages
       WHERE room_id = ? AND deleted_at IS NULL AND type = 'text' AND content LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT 50`
    )
    .all(roomId, `%${q.replace(/[%_]/g, "\\$&")}%`);

  res.json({
    results: rows.map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      content: m.content,
      createdAt: m.created_at,
    })),
  });
}

function getMediaTab(req, res) {
  const roomId = req.params.roomId;
  const membership = getMembership(roomId, req.user.id);
  if (!membership) return res.status(403).json({ error: "Not a member of this room." });

  const kind = req.query.kind || "all"; // image | video | audio | file | links | all
  const search = (req.query.q || "").trim();
  const sort = req.query.sort === "oldest" ? "ASC" : "DESC";

  if (kind === "links") {
    const rows = db
      .prepare(
        `SELECT id, sender_name, type, content, created_at FROM messages
         WHERE room_id = ? AND type = 'text' AND deleted_at IS NULL AND content LIKE '%http%'
         ORDER BY created_at ${sort} LIMIT 200`
      )
      .all(roomId);

    const urlRe = /(https?:\/\/[^\s]+)/g;
    const links = [];
    for (const row of rows) {
      const matches = row.content.match(urlRe) || [];
      for (const url of matches) {
        if (!search || url.toLowerCase().includes(search.toLowerCase())) {
          links.push({ id: row.id, senderName: row.sender_name, url, createdAt: row.created_at });
        }
      }
    }
    return res.json({ items: links.slice(0, 200) });
  }

  let types;
  if (kind === "image") types = ["image"];
  else if (kind === "video") types = ["video"];
  else if (kind === "audio") types = ["audio"];
  else if (kind === "file") types = ["file"];
  else types = ["image", "video", "audio", "file"];

  const placeholders = types.map(() => "?").join(",");
  const searchClause = search ? "AND file_name LIKE ?" : "";
  const params = [roomId, ...types, ...(search ? [`%${search.replace(/[%_]/g, "\\$&")}%`] : [])];

  const rows = db
    .prepare(
      `SELECT id, sender_name, type, content, file_name, file_size, file_type, created_at
       FROM messages WHERE room_id = ? AND type IN (${placeholders}) AND deleted_at IS NULL ${searchClause}
       ORDER BY created_at ${sort} LIMIT 200`
    )
    .all(...params);

  res.json({ items: rows });
}

module.exports = {
  myRooms,
  createRoom,
  joinRoom,
  getRoom,
  getMembers,
  leaveRoom,
  deleteRoom,
  updateRoom,
  transferOwnership,
  moderateMember,
  getMessages,
  searchMessages,
  getMediaTab,
  getMembership,
  roomSummary,
  getMemberCount,
  getPendingRequests,
  approvePendingRequest,
  rejectPendingRequest,
};
