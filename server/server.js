"use strict";

const config = require("./src/config");
const { server } = require("./src/app");
const db = require("./src/db");

server.listen(config.port, "0.0.0.0", () => {
  const displayUrl = config.nodeEnv === "production" ? `port ${config.port}` : `http://localhost:${config.port}`;
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   EchoLink Messenger server                       ║
  ║   ${displayUrl}
  ║   Environment: ${config.nodeEnv}
  ╚══════════════════════════════════════════════════╝
  `);
});

function shutdown() {
  server.close(() => {
    // WAL mode already makes SQLite crash-safe, but an explicit clean
    // close still matters — Render sends SIGTERM on every restart/redeploy,
    // and this checkpoints WAL data properly rather than relying on that
    // safety net every single time.
    try { db.close(); } catch (e) { /* already closed or nothing to flush */ }
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
