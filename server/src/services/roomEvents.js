"use strict";

const { EventEmitter } = require("events");

// A small decoupling point: room.controller.js needs to trigger call
// cleanup when a room is deleted, but the call-cleanup logic lives in
// sockets/calls.js and sockets/group-calls.js, which themselves require
// room.controller.js (for getMembership). Having room.controller.js
// require those modules directly would create a require cycle. Emitting
// an event here and letting sockets/index.js (which already needs both
// modules and has `io` in scope) subscribe avoids that entirely.
module.exports = new EventEmitter();
