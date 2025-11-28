import express from "express";
import { sendBroadcast, getBroadcastsForStudent } from "../controllers/broadcastController.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js";

const router = express.Router();

// 🟢 Teacher sends a broadcast to all students of their subject
router.post("/send", verifyTeacher, sendBroadcast);

// 🔵 Student fetches broadcasts for their subjects
router.get("/student/:studentId", getBroadcastsForStudent);

export default router;
