"use strict";

const xss = require("xss");

// Whitelist nothing — chat text is plain text, rendered with textContent on
// the client, but we still strip any markup server-side as defense in depth.
const xssOptions = {
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
};

function sanitizeText(input, maxLength = 4000) {
  if (typeof input !== "string") return "";
  const trimmed = input.slice(0, maxLength);
  return xss(trimmed, xssOptions).trim();
}

function sanitizeFileName(name, maxLength = 150) {
  if (typeof name !== "string") return "file";
  const clean = name
    .replace(/[/\\]/g, "_")
    .replace(/[^\w.\- ]/g, "")
    .slice(0, maxLength)
    .trim();
  return clean || "file";
}

/** Finds @username mentions in text, matching against a known set of room
 * member usernames (so we don't "detect" mentions of people not even in the
 * room, and username matching is exact rather than a loose regex guess). */
function extractMentions(text, knownUsernames) {
  if (!text || !knownUsernames?.length) return [];
  const lowerSet = new Map(knownUsernames.map((u) => [u.toLowerCase(), u]));
  const found = new Set();
  const re = /@([a-zA-Z0-9_.]{3,20})/g;
  let match;
  while ((match = re.exec(text))) {
    const real = lowerSet.get(match[1].toLowerCase());
    if (real) found.add(real);
  }
  return [...found];
}

module.exports = { sanitizeText, sanitizeFileName, extractMentions };
