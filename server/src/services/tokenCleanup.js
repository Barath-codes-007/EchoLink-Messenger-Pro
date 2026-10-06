"use strict";

const db = require("../db");

/**
 * Deletes refresh tokens that are expired, or were revoked more than
 * `graceSeconds` ago. Every login/refresh/logout inserts or revokes a row
 * in `refresh_tokens` and nothing was ever removing them — left alone this
 * table grows forever. The grace period on revoked tokens (rather than
 * deleting them immediately) keeps a short audit trail for spotting replay
 * attempts on an already-rotated token.
 */
function sweepRefreshTokens(graceSeconds = 7 * 24 * 60 * 60) {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `DELETE FROM refresh_tokens
       WHERE expires_at < ?
          OR (revoked_at IS NOT NULL AND revoked_at < ?)`
    )
    .run(nowSec, nowSec - graceSeconds);
  return result.changes;
}

function startTokenCleanupSweep(intervalMs = 6 * 60 * 60 * 1000) {
  sweepRefreshTokens(); // also run once at startup, not just after the first interval elapses
  const timer = setInterval(() => sweepRefreshTokens(), intervalMs);
  if (timer.unref) timer.unref(); // don't keep the process alive just for this
  return timer;
}

module.exports = { sweepRefreshTokens, startTokenCleanupSweep };
