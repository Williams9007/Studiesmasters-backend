import express from "express";
import { sendBroadcast } from "../controllers/broadcastController.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js"; // or verifyTeacher

const router = express.Router();

// Admin sends broadcast
router.post("/admin/broadcasts", verifyAdmin, sendBroadcast);

export default router;
