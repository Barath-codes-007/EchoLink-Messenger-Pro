"use strict";

const express = require("express");
const router = express.Router();
const userController = require("../controllers/user.controller");
const { requireAuth } = require("../middleware/auth");
const upload = require("../middleware/upload");

router.use(requireAuth);

router.patch("/me", userController.updateProfile);
router.post("/me/avatar", upload.single("avatar"), userController.uploadAvatar);
router.post("/me/change-password", userController.changePassword);
router.delete("/me", userController.deleteAccount);
router.get("/me/export", userController.exportData);

module.exports = router;
