"use strict";

const path = require("path");
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { getMembership } = require("../controllers/room.controller");
const config = require("../config");
const db = require("../db");

const AUDIO_MIME_BY_EXT = {
  ".awebm": "audio/webm",
  ".aogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".weba": "audio/webm",
};

// Serves uploaded files privately: a request must be authenticated *and*
// the requester must either be the uploader, or a member of the room the
// file was ultimately attached to. Replaces the old unrestricted
// `express.static('/uploads')` mount, which let anyone with a URL (e.g.
// leaked in logs, screenshots, or a shared link) download any file
// regardless of room membership.
router.get("/:filename", requireAuth, (req, res) => {
  const filename = req.params.filename;
  // Filenames are always server-generated UUIDs — reject anything else
  // outright rather than letting a crafted value reach the filesystem.
  if (!/^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/.test(filename)) {
    return res.status(400).json({ error: "Invalid file reference." });
  }

  const record = db.prepare("SELECT * FROM uploads WHERE filename = ?").get(filename);
  if (!record) return res.status(404).json({ error: "File not found." });

  const isUploader = record.user_id === req.user.id;
  const isRoomMember = record.room_id ? !!getMembership(record.room_id, req.user.id) : false;
  // Not yet attached to a message/room: only the uploader can fetch it
  // (covers the brief window between upload and the socket message:send
  // call that associates it with a room).
  if (!isUploader && !isRoomMember) {
    return res.status(403).json({ error: "You don't have access to this file." });
  }

  const ext = path.extname(filename).toLowerCase();
  const filePath = path.join(config.uploadDir, filename);
  res.set("Cache-Control", "private, max-age=604800"); // 7d, matches prior static config, but not publicly cacheable
  if (AUDIO_MIME_BY_EXT[ext]) res.type(AUDIO_MIME_BY_EXT[ext]);

  res.sendFile(filePath, { acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "File not found." });
  });
});

module.exports = router;
