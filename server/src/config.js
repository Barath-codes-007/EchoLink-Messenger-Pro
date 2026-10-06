"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function list(str) {
  return (str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || "development";
const DEV_FALLBACK_JWT_SECRET = "dev_insecure_secret_change_me";
const jwtSecret = process.env.JWT_SECRET || DEV_FALLBACK_JWT_SECRET;

if (nodeEnv === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_FALLBACK_JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  // Fail fast rather than silently signing tokens with a weak/guessable
  // secret in production — a leaked or default secret lets anyone forge
  // valid auth tokens for any user.
  throw new Error(
    "JWT_SECRET is missing or too weak for production. Set a random secret of at least 32 characters " +
      "(e.g. `openssl rand -hex 32`) in your environment before starting the server."
  );
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv,
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:3000",

  jwtSecret,
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "15m",
  refreshTokenExpiresDays: parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS, 10) || 30,
  cookieName: process.env.COOKIE_NAME || "echolink_token",
  refreshCookieName: process.env.REFRESH_COOKIE_NAME || "echolink_refresh",

  dbPath: path.isAbsolute(process.env.DB_PATH || "")
    ? process.env.DB_PATH
    : path.join(__dirname, "..", process.env.DB_PATH || "./data/echolink.db"),

  uploadDir: path.isAbsolute(process.env.UPLOAD_DIR || "")
    ? process.env.UPLOAD_DIR
    : path.join(__dirname, "..", process.env.UPLOAD_DIR || "./uploads"),
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB, 10) || 25,

  maxTempRoomSize: parseInt(process.env.MAX_TEMP_ROOM_SIZE, 10) || 12,
  maxPermanentRoomSize: parseInt(process.env.MAX_PERMANENT_ROOM_SIZE, 10) || 200,
  maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH, 10) || 4000,
  sweepIntervalMs: parseInt(process.env.ROOM_EXPIRY_SWEEP_MS, 10) || 15000,

  stunServers: list(process.env.STUN_SERVERS || "stun:stun.l.google.com:19302"),
  turnServer: process.env.TURN_SERVER || "",
  turnUsername: process.env.TURN_USERNAME || "",
  turnCredential: process.env.TURN_CREDENTIAL || "",

  tenorApiKey: process.env.TENOR_API_KEY || "",
};
