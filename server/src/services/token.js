"use strict";

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const config = require("../config");

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, {
    expiresIn: config.accessTokenExpiresIn,
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** Generates a random opaque refresh token. The raw value is sent to the
 * client (httpOnly cookie); only its SHA-256 hash is stored in the DB, so a
 * leaked database dump alone can't be used to impersonate sessions. */
function generateRefreshToken() {
  const raw = crypto.randomBytes(48).toString("hex");
  const hash = hashToken(raw);
  return { raw, hash };
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

module.exports = { signAccessToken, verifyToken, generateRefreshToken, hashToken };
