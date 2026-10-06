-- ==========================================================================
-- EchoLink Messenger — database schema (SQLite)
-- Fully normalized: users, rooms, membership, messages, reactions, calls.
-- ==========================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_url    TEXT DEFAULT NULL,
  bio           TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'offline'   -- online | away | dnd | invisible | offline
                CHECK (status IN ('online','away','dnd','invisible','offline')),
  theme         TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light')),
  last_seen_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  type          TEXT NOT NULL CHECK (type IN ('temporary','permanent')),
  icon_url      TEXT DEFAULT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT DEFAULT NULL,   -- optional room password (permanent rooms)
  expires_at    INTEGER DEFAULT NULL,        -- ms epoch; temporary rooms only, sweep-deleted once passed
  delete_on_owner_logout INTEGER NOT NULL DEFAULT 0, -- temporary rooms only
  require_approval INTEGER NOT NULL DEFAULT 0, -- if 1, joins go to pending_join_requests until approved
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  muted         INTEGER NOT NULL DEFAULT 0,
  banned        INTEGER NOT NULL DEFAULT 0,
  last_read_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  joined_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  sender_name   TEXT NOT NULL,          -- denormalized snapshot, survives account deletion
  type          TEXT NOT NULL CHECK (type IN ('text','image','file','audio','video','system','poll','announcement','location','gif')),
  content       TEXT DEFAULT '',        -- text body, file path, or JSON payload (poll/location)
  file_name     TEXT DEFAULT NULL,
  file_size     INTEGER DEFAULT NULL,
  file_type     TEXT DEFAULT NULL,
  reply_to_id   TEXT DEFAULT NULL REFERENCES messages(id) ON DELETE SET NULL,
  edited_at     INTEGER DEFAULT NULL,
  deleted_at    INTEGER DEFAULT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0,
  forwarded_from TEXT DEFAULT NULL, -- denormalized "originally sent by X" label, NULL if not forwarded
  mentions      TEXT DEFAULT NULL, -- JSON array of mentioned user IDs, NULL if none
  location_live_until INTEGER DEFAULT NULL, -- for type='location': ms epoch when live-sharing ends, NULL if static/expired
  created_at    INTEGER NOT NULL   -- milliseconds since epoch (app-supplied), NOT strftime seconds
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(reply_to_id);

CREATE TABLE IF NOT EXISTS message_reactions (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji         TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS call_logs (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  caller_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  callee_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  call_type     TEXT NOT NULL CHECK (call_type IN ('voice','video')),
  -- status distinguishes how a call ended: completed (both sides connected,
  -- then hung up normally), missed (never connected before the callee
  -- disappeared), declined (explicit reject), cancelled (caller hung up
  -- before answer), timeout (unanswered within the ring window),
  -- disconnected (was connected, then network/socket dropped), failed
  -- (setup error before connecting).
  status        TEXT NOT NULL CHECK (status IN ('completed','missed','declined','cancelled','timeout','disconnected','failed')),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER DEFAULT NULL,
  duration_sec  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  message_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS starred_messages (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS room_mutes (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER DEFAULT NULL,
  -- Whether the *original* login chose "remember me". Refreshing rotates
  -- the token but must carry this forward unchanged — otherwise a
  -- session-only login silently becomes persistent (or vice versa) the
  -- first time the access token expires and gets refreshed.
  remember_me   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS polls (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  question      TEXT NOT NULL,
  options       TEXT NOT NULL, -- JSON array of option strings
  allow_multiple INTEGER NOT NULL DEFAULT 0,
  closed        INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id       TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_index  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (poll_id, user_id, option_index)
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_name   TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'text',
  content       TEXT NOT NULL,
  send_at       INTEGER NOT NULL, -- ms epoch
  sent          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(sent, send_at);

-- Tracks every uploaded file so it can be authorized and served privately
-- (see /api/files/:filename) instead of via a public static mount, and so
-- orphaned uploads (never attached to a message) can be cleaned up later.
CREATE TABLE IF NOT EXISTS uploads (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL UNIQUE,   -- on-disk name, e.g. "<uuid>.png"
  original_name TEXT DEFAULT NULL,
  mime_type     TEXT DEFAULT NULL,
  size          INTEGER DEFAULT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id       TEXT DEFAULT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id    TEXT DEFAULT NULL REFERENCES messages(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_uploads_room ON uploads(room_id);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);

CREATE TABLE IF NOT EXISTS pending_join_requests (
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (room_id, user_id)
);
