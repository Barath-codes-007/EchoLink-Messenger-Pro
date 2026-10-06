"use strict";

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidUsername(v) {
  return typeof v === "string" && USERNAME_RE.test(v);
}

function isValidEmail(v) {
  return typeof v === "string" && EMAIL_RE.test(v) && v.length <= 254;
}

function isValidPassword(v) {
  // At least 8 chars, one letter, one number — reasonable without being
  // annoying. Real deployments should add breach-list checking (e.g. HIBP).
  return typeof v === "string" && v.length >= 8 && v.length <= 128 && /[A-Za-z]/.test(v) && /\d/.test(v);
}

function isValidRoomName(v) {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 60;
}

module.exports = { isValidUsername, isValidEmail, isValidPassword, isValidRoomName };
