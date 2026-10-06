"use strict";

const express = require("express");
const router = express.Router();
const scheduled = require("../controllers/scheduled.controller");
const { requireAuth } = require("../middleware/auth");

router.use(requireAuth);

router.post("/", scheduled.scheduleMessage);
router.get("/room/:roomId", scheduled.getScheduledMessages);
router.delete("/:id", scheduled.cancelScheduledMessage);

module.exports = router;
