"use strict";

const config = require("../config");
const { verifyToken } = require("../services/token");
const db = require("../db");

function getTokenFromReq(req) {
  if (req.cookies && req.cookies[config.cookieName]) return req.cookies[config.cookieName];
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Not authenticated." });

  const user = db
    .prepare("SELECT id, username, email, avatar_url, bio, status, theme FROM users WHERE id = ?")
    .get(payload.sub);
  if (!user) return res.status(401).json({ error: "User no longer exists." });

  req.user = user;
  next();
}

/** Attaches req.user if a valid token is present, but never blocks the request. */
function optionalAuth(req, _res, next) {
  const token = getTokenFromReq(req);
  const payload = token && verifyToken(token);
  if (payload) {
    const user = db
      .prepare("SELECT id, username, email, avatar_url, bio, status, theme FROM users WHERE id = ?")
      .get(payload.sub);
    if (user) req.user = user;
  }
  next();
}

module.exports = { requireAuth, optionalAuth, getTokenFromReq };
