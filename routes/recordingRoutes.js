// routes/recordingRoutes.js
//
// Recording access and management endpoints.

import express from "express";
import { verifyQao } from "../middleware/verifyQao.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import { studentAuth as verifyStudent } from "../middleware/studentAuth.js";
import recordingService from "../services/recording/recording.service.js";

const router = express.Router();

// Get recording status for a session (teacher/QAO/admin)
router.get("/session/:sessionId/status", verifyTeacher, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const teacherId = req.user._id;
    
    const sessions = await import("../models/ClassSession.js").then(m => 
      m.default.find({ 
        _id: sessionId, 
        $or: [{ teacher: teacherId }, { substituteTeacher: teacherId }] 
      }).lean()
    );
    
    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ success: false, message: "Session not found or not authorized" });
    }

    const session = sessions[0];
    res.json({
      success: true,
      recording: {
        status: session.recording?.status || "pending",
        available: session.recording?.available || false,
        duration: session.recording?.duration || 0,
        thumbnail: session.recording?.thumbnail || "",
        moodleResourceId: session.recording?.moodleResourceId || "",
        processedAt: session.recording?.processedAt || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get pending recordings (admin/QAO dashboard)
router.get("/pending", verifyQao, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const recordings = await recordingService.getPendingRecordings(limit);
    
    res.json({
      success: true,
      recordings: recordings.map(s => ({
        sessionId: s._id,
        subject: s.classGroup?.subject || "",
        grade: s.classGroup?.grade || "",
        teacher: s.teacher?.fullName || "",
        date: s.date,
        status: s.recording?.status || "pending",
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;