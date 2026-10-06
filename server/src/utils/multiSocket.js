"use strict";

// A user can have several live sockets at once — multiple browser tabs,
// multiple devices, or both. None of the original disconnect handlers
// accounted for this: closing *one* tab/device was treated as "this user
// is gone" everywhere (presence going offline, an active 1:1 call ending,
// a group call participant being dropped), even while their other
// tab/device was still fully connected and, in the call cases, actively
// using the connection that was about to get torn down.
//
// This checks the live socket registry Socket.IO already maintains
// (io.sockets.sockets) rather than keeping a second, easy-to-desync copy
// of the same information.

/** True if `userId` has any connected socket other than `excludeSocketId`. */
function hasOtherActiveSockets(io, userId, excludeSocketId) {
  for (const [id, s] of io.sockets.sockets) {
    if (id !== excludeSocketId && s.data.user?.id === userId) return true;
  }
  return false;
}

/** All currently-connected socket ids belonging to `userId` (optionally
 * excluding one, e.g. the socket that's in the middle of disconnecting). */
function socketIdsForUser(io, userId, excludeSocketId) {
  const ids = [];
  for (const [id, s] of io.sockets.sockets) {
    if (id !== excludeSocketId && s.data.user?.id === userId) ids.push(id);
  }
  return ids;
}

module.exports = { hasOtherActiveSockets, socketIdsForUser };
