import express from "express";
import { sendBroadcast } from "../Controllers/broadcasting.js";
import { adminAuth } from "../middleware/adminAuth.js";

const router = express.Router();

// Admin sends broadcast
router.post("/admin/broadcasts", adminAuth, sendBroadcast);
router.post("/admin/broadcasts/send", adminAuth, sendBroadcast);

export default router;
