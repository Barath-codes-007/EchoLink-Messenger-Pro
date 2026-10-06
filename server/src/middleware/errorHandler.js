"use strict";

const config = require("../config");

function notFoundHandler(req, res) {
  res.status(404).json({ error: "Not found." });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.name === "MulterError") {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error("[error]", err);
  res.status(err.status || 500).json({
    error: err.publicMessage || "Something went wrong on our end.",
    ...(config.nodeEnv === "development" ? { detail: err.message } : {}),
  });
}

module.exports = { notFoundHandler, errorHandler };
