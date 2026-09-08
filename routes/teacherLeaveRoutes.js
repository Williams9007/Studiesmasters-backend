// routes/teacherLeaveRoutes.js
// Teacher self-service leave requests: submit, view own status, cancel own
// pending requests. Reviewed by Tutor Managers via /api/qao/leave-requests.
import { Router } from "express";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import * as leave from "../services/qao/leave.service.js";

const router = Router();

// My leave requests (any status)
router.get("/", verifyTeacher, async (req, res) => {
  try {
    res.json({ success: true, requests: await leave.listRequests({ teacherId: req.user._id }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Submit a leave request
router.post("/", verifyTeacher, async (req, res) => {
  try {
    const { leaveType, startDate, endDate, reason } = req.body;
    const request = await leave.submitRequest({
      teacherId: req.user._id,
      leaveType,
      startDate,
      endDate,
      reason,
      submittedBy: "teacher",
    });
    res.status(201).json({ success: true, request });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Cancel one of my pending requests
router.patch("/:id/cancel", verifyTeacher, async (req, res) => {
  try {
    res.json({ success: true, request: await leave.cancelRequest(req.params.id, req.user._id) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

export default router;
