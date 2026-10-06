"use strict";

const db = require("../db");

/**
 * True if either user has blocked the other. Blocking is enforced as
 * mutual for interaction purposes — if A blocked B, B shouldn't be able to
 * call/message A, but A shouldn't be able to call/message B either (a
 * one-way "I can still bother the person who blocked me" would defeat the
 * point). Frontend hiding of blocked users' content is not sufficient on
 * its own — this must be checked server-side on every relevant action.
 */
function isBlocked(userIdA, userIdB) {
  const row = db
    .prepare(
      `SELECT 1 FROM blocked_users
       WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
       LIMIT 1`
    )
    .get(userIdA, userIdB, userIdB, userIdA);
  return !!row;
}

module.exports = { isBlocked };
