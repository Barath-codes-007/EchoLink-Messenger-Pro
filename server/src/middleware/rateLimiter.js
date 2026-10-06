"use strict";

const rateLimit = require("express-rate-limit");

// Generous general API limit — protects against scripted abuse without
// getting in the way of normal use.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

// Tighter limiter for auth endpoints to blunt brute-force / credential
// stuffing attempts against login and signup.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

module.exports = { apiLimiter, authLimiter };
