// routes/streamRoutes.js
//
// Secure streaming endpoints for recordings.
// Provides time-limited, access-controlled streaming URLs.

import express from "express";
import { studentAuth as verifyStudent } from "../middleware/studentAuth.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import { getSecureStreamUrl, logRecordingView } from "../services/recording/recording.service.js";

const router = express.Router();

// Student: Get secure streaming URL
// POST /api/stream/:sessionId/watch
router.post("/:sessionId/watch", verifyStudent, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const userId = req.user._id;

    const result = await getSecureStreamUrl(sessionId, userId, "student", req);

    res.json({
      success: true,
      url: result.url,
      expiresAt: result.expiresAt,
      sessionId: result.sessionId,
      subject: result.subject,
      duration: result.duration,
    });
  } catch (err) {
    const status = err.message.includes("not found") ? 404 : 
                   err.message.includes("denied") ? 403 : 500;
    res.status(status).json({ 
      success: false, 
      message: err.message.includes("Access denied") ? "Access denied" : err.message 
    });
  }
});

// Teacher: Get secure streaming URL for own class
router.post("/teacher/:sessionId/watch", verifyTeacher, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const userId = req.user._id;

    const result = await getSecureStreamUrl(sessionId, userId, "teacher", req);

    res.json({
      success: true,
      url: result.url,
      expiresAt: result.expiresAt,
      sessionId: result.sessionId,
      subject: result.subject,
      duration: result.duration,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Log viewing activity (called by frontend during playback)
router.post("/:sessionId/view-log", verifyStudent, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const userId = req.user._id;

    await logRecordingView(sessionId, userId, req);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;