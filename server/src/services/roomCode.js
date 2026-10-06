"use strict";

const db = require("../db");

// Avoid ambiguous characters (0/O, 1/I/L) so codes are easy to read aloud
// and type on a phone keyboard.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(length = 6) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** Generates a short, unique, human-friendly room code. */
function generateUniqueRoomCode() {
  const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?");
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode(6);
    if (!exists.get(code)) return code;
  }
  // Astronomically unlikely fallback with a longer code.
  return randomCode(10);
}

module.exports = { generateUniqueRoomCode };
