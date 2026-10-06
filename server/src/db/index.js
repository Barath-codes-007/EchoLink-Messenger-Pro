"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config");

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

// --- Migration: widen call_logs.status CHECK constraint on pre-existing DBs ---
// SQLite can't ALTER a CHECK constraint in place, so rebuild the table when an
// older schema version (without 'cancelled') is detected. No-ops on fresh DBs
// (the CREATE TABLE above already has the wide constraint) and on DBs that
// already migrated. Existing rows are preserved.
const callLogsDef = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'call_logs'").get();
if (callLogsDef && !callLogsDef.sql.includes("'cancelled'")) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE call_logs RENAME TO call_logs_old;
      CREATE TABLE call_logs (
        id            TEXT PRIMARY KEY,
        room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        caller_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
        callee_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
        call_type     TEXT NOT NULL CHECK (call_type IN ('voice','video')),
        status        TEXT NOT NULL CHECK (status IN ('completed','missed','declined','cancelled','timeout','disconnected','failed')),
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER DEFAULT NULL,
        duration_sec  INTEGER DEFAULT 0
      );
      INSERT INTO call_logs SELECT * FROM call_logs_old;
      DROP TABLE call_logs_old;
    `);
  })();
}

// --- Migration: add refresh_tokens.remember_me on pre-existing DBs ---
// A simple ADD COLUMN (unlike the call_logs CHECK-constraint change above,
// this doesn't need a full table rebuild). Existing rows default to 1
// (remember-me) — the safest assumption for sessions that already predate
// this column, since it just means they behave as they always did.
const refreshTokensCols = db.prepare("PRAGMA table_info(refresh_tokens)").all();
if (!refreshTokensCols.some((c) => c.name === "remember_me")) {
  db.exec("ALTER TABLE refresh_tokens ADD COLUMN remember_me INTEGER NOT NULL DEFAULT 1");
}

module.exports = db;
