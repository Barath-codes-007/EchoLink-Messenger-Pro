"use strict";

const express = require("express");
const router = express.Router();
const roomController = require("../controllers/room.controller");
const { requireAuth } = require("../middleware/auth");

router.use(requireAuth);

router.get("/", roomController.myRooms);
router.post("/", roomController.createRoom);
router.post("/join", roomController.joinRoom);
router.get("/:roomId", roomController.getRoom);
router.patch("/:roomId", roomController.updateRoom);
router.delete("/:roomId", roomController.deleteRoom);
router.post("/:roomId/leave", roomController.leaveRoom);
router.get("/:roomId/members", roomController.getMembers);
router.post("/:roomId/transfer", roomController.transferOwnership);
router.post("/:roomId/moderate", roomController.moderateMember);
router.get("/:roomId/messages", roomController.getMessages);
router.get("/:roomId/messages/search", roomController.searchMessages);
router.get("/:roomId/pending", roomController.getPendingRequests);
router.post("/:roomId/pending/:userId/approve", roomController.approvePendingRequest);
router.post("/:roomId/pending/:userId/reject", roomController.rejectPendingRequest);
router.get("/:roomId/media", roomController.getMediaTab);

module.exports = router;
