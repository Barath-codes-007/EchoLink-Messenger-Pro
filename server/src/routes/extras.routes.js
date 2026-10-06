"use strict";

const express = require("express");
const router = express.Router();
const extras = require("../controllers/extras.controller");
const { requireAuth } = require("../middleware/auth");

router.use(requireAuth);

router.post("/messages/:messageId/star", extras.starMessage);
router.delete("/messages/:messageId/star", extras.unstarMessage);
router.get("/users/me/starred", extras.getStarredMessages);

router.post("/users/:userId/block", extras.blockUser);
router.delete("/users/:userId/block", extras.unblockUser);
router.get("/users/me/blocked", extras.getBlockedUsers);

router.post("/rooms/:roomId/mute", extras.setMute);

router.post("/reports", extras.createReport);

router.get("/users/me/calls", extras.getCallHistory);

module.exports = router;
