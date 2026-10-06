"use strict";

const bcrypt = require("bcryptjs");
const db = require("../db");
const { publicUser } = require("./auth.controller");

function updateProfile(req, res) {
  const { bio, theme, status } = req.body || {};
  const fields = [];
  const values = [];

  if (typeof bio === "string") {
    fields.push("bio = ?");
    values.push(bio.slice(0, 300));
  }
  if (theme === "dark" || theme === "light") {
    fields.push("theme = ?");
    values.push(theme);
  }
  if (["online", "away", "dnd", "invisible", "offline"].includes(status)) {
    fields.push("status = ?");
    values.push(status);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "Nothing to update." });
  }

  values.push(req.user.id);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: publicUser(user) });
}

function uploadAvatar(req, res) {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const avatarUrl = `/uploads/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, req.user.id);
  res.json({ avatarUrl });
}

function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);

  if (!bcrypt.compareSync(currentPassword || "", user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }

  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  res.json({ ok: true });
}

function deleteAccount(req, res) {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.user.id);
  res.clearCookie(require("../config").cookieName, { path: "/" });
  res.json({ ok: true });
}

function exportData(req, res) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const rooms = db
    .prepare(
      `SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ?`
    )
    .all(req.user.id);
  const messages = db.prepare("SELECT * FROM messages WHERE sender_id = ?").all(req.user.id);

  res.setHeader("Content-Disposition", "attachment; filename=echolink-export.json");
  res.json({ user: publicUser(user), rooms, messages, exportedAt: new Date().toISOString() });
}

module.exports = { updateProfile, uploadAvatar, changePassword, deleteAccount, exportData };
