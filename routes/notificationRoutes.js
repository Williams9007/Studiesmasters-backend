// routes/notificationRoutes.js
import express from "express";
import { getNotifications, markRead } from "../controllers/notificationController.js";

const router = express.Router();

router.get("/", getNotifications);
router.post("/:id/read", markRead);

export default router;
