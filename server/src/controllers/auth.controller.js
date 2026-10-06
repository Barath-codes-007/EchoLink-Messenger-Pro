"use strict";

const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const config = require("../config");
const { signAccessToken, generateRefreshToken, hashToken } = require("../services/token");
const { isValidUsername, isValidEmail, isValidPassword } = require("../utils/validators");

const accessCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: config.nodeEnv === "production",
  maxAge: 15 * 60 * 1000,
  path: "/",
};

const refreshCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: config.nodeEnv === "production",
  maxAge: config.refreshTokenExpiresDays * 24 * 60 * 60 * 1000,
  path: "/api/auth", // only sent to auth endpoints — narrows exposure of the long-lived token
};

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    avatarUrl: u.avatar_url,
    bio: u.bio,
    status: u.status,
    theme: u.theme,
  };
}

/** Issues a fresh access + refresh token pair for a user and sets both cookies. */
function issueSession(res, user, rememberMe) {
  const accessToken = signAccessToken(user);
  res.cookie(config.cookieName, accessToken, accessCookieOptions);

  const { raw, hash } = generateRefreshToken();
  const expiresAt = Date.now() + config.refreshTokenExpiresDays * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, remember_me) VALUES (?, ?, ?, ?, ?)").run(
    uuidv4(),
    user.id,
    hash,
    Math.floor(expiresAt / 1000),
    rememberMe ? 1 : 0
  );

  // "Remember me" = long-lived cookie; otherwise the cookie is a session
  // cookie (cleared when the browser closes) even though the DB record
  // itself still lives for the full window, in case they said yes elsewhere.
  const cookieOpts = rememberMe === false ? { ...refreshCookieOptions, maxAge: undefined } : refreshCookieOptions;
  res.cookie(config.refreshCookieName, raw, cookieOpts);

  return accessToken;
}

function signup(req, res) {
  const { username, email, password } = req.body || {};

  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, _ or ." });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "Password must be at least 8 characters and include a letter and a number." });
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE")
    .get(username, email);
  if (existing) {
    return res.status(409).json({ error: "That username or email is already taken." });
  }

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 12);

  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, status, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'online', strftime('%s','now'), strftime('%s','now'))`
  ).run(id, username, email, passwordHash);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const token = issueSession(res, user, true);
  res.status(201).json({ user: publicUser(user), token });
}

function login(req, res) {
  const { identifier, password, rememberMe } = req.body || {};
  if (typeof identifier !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Missing credentials." });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE")
    .get(identifier, identifier);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect username/email or password." });
  }

  db.prepare("UPDATE users SET status = 'online', last_seen_at = strftime('%s','now') WHERE id = ?").run(user.id);

  const token = issueSession(res, user, rememberMe !== false);
  res.json({ user: publicUser(user), token });
}

/** Exchanges a valid refresh token for a new access token, rotating the
 * refresh token itself (old one is revoked immediately) to limit the
 * damage window if a refresh token is ever stolen. */
function refresh(req, res) {
  const rawToken = req.cookies?.[config.refreshCookieName];
  if (!rawToken) return res.status(401).json({ error: "No refresh token." });

  const hash = hashToken(rawToken);
  const record = db
    .prepare("SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .get(hash);

  if (!record || record.expires_at < Math.floor(Date.now() / 1000)) {
    res.clearCookie(config.refreshCookieName, { path: "/api/auth" });
    return res.status(401).json({ error: "Refresh token expired or invalid. Please log in again." });
  }

  db.prepare("UPDATE refresh_tokens SET revoked_at = strftime('%s','now') WHERE id = ?").run(record.id);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(record.user_id);
  if (!user) return res.status(401).json({ error: "User no longer exists." });

  // Rotate the token, but preserve the *original* remember-me choice from
  // when the user actually logged in — refreshing must not silently turn
  // a session-only login into a persistent one (or the reverse).
  const token = issueSession(res, user, !!record.remember_me);
  res.json({ user: publicUser(user), token });
}

function logout(req, res) {
  const rawToken = req.cookies?.[config.refreshCookieName];
  if (rawToken) {
    db.prepare("UPDATE refresh_tokens SET revoked_at = strftime('%s','now') WHERE token_hash = ?").run(hashToken(rawToken));
  }
  if (req.user) {
    db.prepare("UPDATE users SET status = 'offline', last_seen_at = strftime('%s','now') WHERE id = ?").run(req.user.id);
    const io = req.app.get("io");
    if (io) require("../services/roomExpiry").deleteOwnerLogoutRooms(io, req.user.id);
  }
  res.clearCookie(config.cookieName, { path: "/" });
  res.clearCookie(config.refreshCookieName, { path: "/api/auth" });
  res.json({ ok: true });
}

function me(req, res) {
  res.json({ user: publicUser(req.user) });
}

module.exports = { signup, login, logout, me, refresh, publicUser };
