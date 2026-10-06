"use strict";

const express = require("express");
const router = express.Router();

router.use("/auth", require("./auth.routes"));
router.use("/users", require("./user.routes"));
router.use("/rooms", require("./room.routes"));
router.use("/upload", require("./upload.routes"));
router.use("/files", require("./files.routes"));
router.use("/scheduled-messages", require("./scheduled.routes"));
router.use("/", require("./extras.routes"));

const { requireAuth } = require("../middleware/auth");

router.get("/config/rtc", requireAuth, (_req, res) => {
  const config = require("../config");
  const iceServers = config.stunServers.map((url) => ({ urls: url }));
  if (config.turnServer) {
    iceServers.push({
      urls: config.turnServer,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }
  res.json({ iceServers });
});

// GIF search is proxied server-side so the Tenor API key never reaches the
// browser. Without a key configured, this degrades gracefully rather than
// pretending GIFs work — the client shows a clear "not configured" message.
router.get("/gifs/search", requireAuth, async (req, res) => {
  const config = require("../config");
  if (!config.tenorApiKey) {
    return res.status(501).json({ error: "GIF search isn't configured. Set TENOR_API_KEY in your .env to enable it.", configured: false });
  }
  const q = (req.query.q || "trending").toString().slice(0, 60);
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${config.tenorApiKey}&limit=24&media_filter=gif`;
    const tenorRes = await fetch(url);
    if (!tenorRes.ok) return res.status(502).json({ error: "GIF provider request failed." });
    const data = await tenorRes.json();
    const gifs = (data.results || []).map((r) => ({
      id: r.id,
      previewUrl: r.media_formats?.tinygif?.url || r.media_formats?.gif?.url,
      url: r.media_formats?.gif?.url,
    })).filter((g) => g.url);
    res.json({ gifs, configured: true });
  } catch (err) {
    res.status(502).json({ error: "Couldn't reach GIF provider." });
  }
});

module.exports = router;
