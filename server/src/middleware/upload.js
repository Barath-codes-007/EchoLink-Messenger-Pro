"use strict";

const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const config = require("../config");
const db = require("../db");

if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });

// Extensions we knowingly accept. Anything else is rejected outright —
// executables, scripts, etc. never touch disk.
// SVG is intentionally excluded: an SVG can embed <script>/event-handler
// content and is not safe to serve back inline without a real sanitizer.
// Set ALLOW_SVG_UPLOADS=1 only if a proper SVG sanitizer is added downstream.
const ALLOWED_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".mp4", ".webm", ".mov",
  ".mp3", ".wav", ".ogg", ".m4a", ".weba",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".txt", ".csv", ".json",
]);
if (process.env.ALLOW_SVG_UPLOADS === "1") ALLOWED_EXT.add(".svg");

// Magic-byte signatures used to verify the file's *actual* content matches
// what its extension claims — extensions and client-supplied MIME types are
// trivially spoofable and must never be trusted alone. Formats without a
// reliable fixed signature (plain text: txt/csv/json) are skipped here; they
// can't execute as anything other than text regardless of content.
const SIGNATURES = {
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ".gif": [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ".webp": [[0x52, 0x49, 0x46, 0x46]], // "RIFF" (WEBP marker follows at byte 8, checked separately)
  ".pdf": [[0x25, 0x50, 0x44, 0x46]], // "%PDF"
  ".zip": [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]],
  // Office Open XML formats (.docx/.xlsx/.pptx) are ZIP containers.
  ".docx": [[0x50, 0x4b, 0x03, 0x04]],
  ".xlsx": [[0x50, 0x4b, 0x03, 0x04]],
  ".pptx": [[0x50, 0x4b, 0x03, 0x04]],
  // Legacy binary Office formats (.doc/.xls/.ppt) share the OLE2 signature.
  ".doc": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ".xls": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ".ppt": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ".mp3": [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2]],
  ".wav": [[0x52, 0x49, 0x46, 0x46]], // "RIFF" (WAVE marker follows at byte 8, checked separately)
  ".ogg": [[0x4f, 0x67, 0x67, 0x53]], // "OggS"
  ".weba": [[0x1a, 0x45, 0xdf, 0xa3]], // EBML/WebM header
  ".webm": [[0x1a, 0x45, 0xdf, 0xa3]],
  // mp4/mov/m4a are ISO-BMFF containers: bytes 4-7 are "ftyp"; there's no
  // fixed prefix at byte 0, so these are checked specially below.
};

function bufferStartsWith(buffer, sig) {
  if (buffer.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buffer[i] !== sig[i]) return false;
  }
  return true;
}

/** Returns true if the file's actual bytes are consistent with `ext`. */
function verifySignature(buffer, ext) {
  if (ext === ".mp4" || ext === ".mov" || ext === ".m4a") {
    // ISO-BMFF: 4-byte size, then ASCII "ftyp" at offset 4.
    return buffer.length >= 8 && buffer.slice(4, 8).toString("ascii") === "ftyp";
  }
  if (ext === ".webp") {
    return (
      buffer.length >= 12 &&
      buffer.slice(0, 4).toString("ascii") === "RIFF" &&
      buffer.slice(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (ext === ".wav") {
    return (
      buffer.length >= 12 &&
      buffer.slice(0, 4).toString("ascii") === "RIFF" &&
      buffer.slice(8, 12).toString("ascii") === "WAVE"
    );
  }
  const sigs = SIGNATURES[ext];
  if (!sigs) return true; // no known signature (plain text formats) — nothing to verify
  return sigs.some((sig) => bufferStartsWith(buffer, sig));
}

// Buffer in memory rather than streaming straight to disk: this lets us
// verify the file's real content (magic bytes) *before* anything with an
// attacker-chosen extension ever touches the filesystem.
const storage = multer.memoryStorage();

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return cb(new Error(`File type "${ext || "unknown"}" is not allowed.`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

/**
 * Runs after `upload.single(...)`. Verifies the buffered file's magic bytes,
 * writes it to disk under a random UUID filename (never the client-supplied
 * name), and records it in the `uploads` table so it can later be tied to a
 * room/message and authorized on read (see routes/files.routes.js).
 */
function persistUpload(req, res, next) {
  if (!req.file) return next();
  const originalExt = path.extname(req.file.originalname).toLowerCase();
  let ext = originalExt;

  if (!verifySignature(req.file.buffer, originalExt)) {
    return res.status(400).json({ error: "File content doesn't match its extension." });
  }

  // .webm and .ogg containers are used by both voice notes (audio) and video
  // clips — since the on-disk filename is a UUID (no original name to
  // inspect later), tag audio uploads with a distinct extension now so file
  // serving can set the correct Content-Type deterministically.
  if (req.file.mimetype && req.file.mimetype.startsWith("audio/")) {
    if (ext === ".webm") ext = ".awebm";
    else if (ext === ".ogg") ext = ".aogg";
  }

  const filename = `${uuidv4()}${ext}`;
  const destPath = path.join(config.uploadDir, filename);

  fs.writeFile(destPath, req.file.buffer, (err) => {
    if (err) return next(err);

    db.prepare(
      `INSERT INTO uploads (id, filename, original_name, mime_type, size, user_id, room_id, message_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(uuidv4(), filename, req.file.originalname.slice(0, 200), req.file.mimetype || null, req.file.size, req.user.id);

    req.file.filename = filename;
    req.file.path = destPath;
    next();
  });
}

module.exports = upload;
module.exports.persistUpload = persistUpload;
module.exports.verifySignature = verifySignature;
