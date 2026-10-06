"use strict";

const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const { Server } = require("socket.io");

const config = require("./config");
const routes = require("./routes");
const initSockets = require("./sockets");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const { apiLimiter } = require("./middleware/rateLimiter");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: config.clientOrigin, credentials: true },
  maxHttpBufferSize: 2 * 1024 * 1024, // signaling/text only — files go through REST upload, not sockets
});

app.use(
  helmet({
    contentSecurityPolicy: false, // the public/ frontend is same-origin static HTML/CSS/JS; CSP can be tightened per-deployment
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(compression());
app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use("/api", apiLimiter);

// Uploaded files are private and served only through the authenticated
// GET /api/files/:filename route (see routes/files.routes.js), which checks
// room membership before streaming anything. There is intentionally no
// static mount for the upload directory — that would make every uploaded
// file downloadable by anyone who has (or guesses) its URL.
app.use(express.static(path.join(__dirname, "..", "..", "public")));

app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.use("/api", routes);

initSockets(io);
app.set("io", io);
require("./services/roomExpiry").startExpirySweep(io, config.sweepIntervalMs);
require("./services/tokenCleanup").startTokenCleanupSweep();

// Defensive safety nets — normal call-end/disconnect handling already
// cleans these up; this only catches the rare case where a cleanup event
// is somehow missed, so in-memory call state can't grow unboundedly over
// a long-running process.
const { sweepAbandonedCalls } = require("./sockets/calls");
const { sweepAbandonedGroupCalls } = require("./sockets/group-calls");
setInterval(() => {
  sweepAbandonedCalls(io);
  sweepAbandonedGroupCalls(io);
}, 2 * 60 * 1000).unref?.();

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = { app, server };
