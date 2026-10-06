"use strict";

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");

router.use(requireAuth);

// Generic attachment upload used by the chat composer (images, files, voice
// notes, video clips). Returns a URL the client then sends over the socket
// as a chat message referencing this file. The file is *not* publicly
// accessible at this URL — see routes/files.routes.js for the authorization
// check that runs when it's actually fetched.
router.post("/", upload.single("attachment"), upload.persistUpload, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  res.status(201).json({
    url: `/api/files/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    fileType: req.file.mimetype,
  });
});

module.exports = router;
