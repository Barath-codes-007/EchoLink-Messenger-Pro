"use strict";

// express-rate-limit (used for the HTTP routes) has no effect on Socket.IO
// events at all — messages, reactions, and call signaling all travel over
// the socket, not HTTP, and previously had zero rate limiting. This is a
// minimal fixed-window limiter for exactly that gap.
//
// Keyed by userId (not socket.id) so a reconnect — which gets a fresh
// socket.id — doesn't hand an abusive user a brand new allowance.
const buckets = new Map(); // key -> { count, windowStart }

/** Returns true if this call is allowed under the given limit/window. */
function allow(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

// Periodically drop stale buckets so this map doesn't grow unbounded across
// a long-running process.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 10 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

module.exports = { allow };
