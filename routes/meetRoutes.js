// routes/meetRoutes.js
//
// Virtual classroom endpoints. These are thin HTTP surfaces over the
// scheduling/google services. Key security properties:
//   - Student "join" only returns a meeting link after checking that the
//     student is a member of the session's ClassGroup (enrollment gate).
//   - Meeting links are NEVER exposed via list/index endpoints; they are only
//     returned in the join handshake to the entitled student (or to the
//     teacher/admin/QAO for management of that specific session).
//   - No student PII leaks through any response.
import { Router } from "express";
import ClassSession from "../models/ClassSession.js";
import ClassGroup from "../models/ClassGroup.js";
import { studentAuth } from "../middleware/studentAuth.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import { verifyQao } from "../middleware/verifyQao.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { recordAttendance, listAttendance, regenerateMeeting } from "../services/qao/scheduling.service.js";
import { emitToAdmin, emitToQaos } from "../services/qao/notify.js";
import * as exporter from "../services/qao/export.service.js";

const router = Router();

/** Resolve a session with its classGroup populated (lean). */
async function loadSession(id) {
  const session = await ClassSession.findById(id)
    .populate("classGroup", "code subject grade curriculum students")
    .populate("teacher", "fullName email")
    .populate("substituteTeacher", "fullName email")
    .lean();
  if (!session) {
    const err = new Error("Session not found");
    err.statusCode = 404;
    throw err;
  }
  return session;
}

// ---------------------------------------------------------------------------
// Student: list MY upcoming virtual classes (enrollment-gated)
// GET /api/meet/student/sessions
// Only returns sessions whose class group contains req.user._id.
// ---------------------------------------------------------------------------
router.get("/student/sessions", studentAuth, async (req, res) => {
  try {
    const studentId = req.user._id;
    const groups = await ClassGroup.find({ students: studentId }).select("_id").lean();
    const groupIds = groups.map((g) => g._id);
    const sessions = await ClassSession.find({
      classGroup: { $in: groupIds },
      status: { $in: ["scheduled", "live"] },
    })
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .sort({ date: 1, startTime: 1 })
      .lean();

    const today = new Date().toISOString().slice(0, 10);
    const payload = sessions
      .filter((s) => new Date(s.date).toISOString().slice(0, 10) >= today)
      .map((s) => ({
        sessionId: s._id,
        subject: s.classGroup?.subject || "",
        grade: s.classGroup?.grade || "",
        curriculum: s.classGroup?.curriculum || "",
        teacher: s.teacher?.fullName || "",
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        status: s.status,
        canJoin: s.status === "live", // meeting link is never listed here
      }));

    res.json({ success: true, sessions: payload });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ---------------------------------------------------------------------------
// Student: JOIN a live class — the only place a student receives the link.
// POST /api/meet/student/:sessionId/join
// ---------------------------------------------------------------------------
router.post(["/student/:sessionId/join", "/join/:sessionId"], studentAuth, async (req, res) => {
  try {
    const session = await loadSession(req.params.sessionId);
    const studentId = req.user._id;
    const group = session.classGroup;

    // Enrollment gate: student MUST belong to this session's class group.
    const enrolled =
      group &&
      Array.isArray(group.students) &&
      group.students.some((id) => String(id) === String(studentId));
    if (!enrolled) {
      return res.status(403).json({ success: false, message: "You are not enrolled in this class" });
    }

    if (session.status === "completed" || session.status === "cancelled") {
      return res.status(400).json({ success: false, message: "This class is no longer joinable" });
    }

    // Record the join (practical attendance: Google Meet doesn't expose this).
    await recordAttendance(session._id, { student: studentId, joinedAt: new Date(), source: "client" });

    res.json({
      success: true,
      session: {
        sessionId: session._id,
        subject: group?.subject || "",
        grade: group?.grade || "",
        teacher: session.teacher?.fullName || "",
        date: session.date,
        startTime: session.startTime,
        endTime: session.endTime,
      },
      meeting: {
        link: session.meetingLink || "",
        status: session.meetingStatus,
      },
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Student: mark leave (close meeting). Client reports leftAt; duration computed.
// POST /api/meet/student/:sessionId/leave
// ---------------------------------------------------------------------------
router.post(["/student/:sessionId/leave", "/leave/:sessionId"], studentAuth, async (req, res) => {
  try {
    const session = await loadSession(req.params.sessionId);
    const studentId = req.user._id;
    const group = session.classGroup;
    const enrolled =
      group && Array.isArray(group.students) && group.students.some((id) => String(id) === String(studentId));
    if (!enrolled) {
      return res.status(403).json({ success: false, message: "You are not enrolled in this class" });
    }
    const updated = await recordAttendance(session._id, {
      student: studentId,
      joinedAt: req.body?.joinedAt ? new Date(req.body.joinedAt) : null,
      leftAt: new Date(),
      source: "client",
    });
    res.json({ success: true, attendance: updated });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});
// ---------------------------------------------------------------------------
// Teacher: my virtual classes (today's + upcoming that I teach or substitute)
// GET /api/meet/teacher/sessions
// ---------------------------------------------------------------------------
router.get("/teacher/sessions", verifyTeacher, async (req, res) => {
  try {
    const teacherId = req.user._id;
    const sessions = await ClassSession.find({
      $or: [{ teacher: teacherId }, { substituteTeacher: teacherId }],
      status: { $in: ["scheduled", "live"] },
    })
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .sort({ date: 1, startTime: 1 })
      .lean();
    const payload = sessions.map((s) => ({
      sessionId: s._id,
      subject: s.classGroup?.subject || "",
      grade: s.classGroup?.grade || "",
      curriculum: s.classGroup?.curriculum || "",
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      meetingStatus: s.meetingStatus,
      meetingLink: s.meetingLink, // teacher may manage their own meeting link
      isSubstitute: String(s.substituteTeacher || "") === String(teacherId),
    }));
    res.json({ success: true, sessions: payload });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Teacher: start a class (marks it live) and returns the link.
// POST /api/meet/teacher/:sessionId/start
// ---------------------------------------------------------------------------
router.post("/teacher/:sessionId/start", verifyTeacher, async (req, res) => {
  try {
    const teacherId = req.user._id;
    const session = await loadSession(req.params.sessionId);
    const isAssigned =
      String(session.teacher?._id || "") === String(teacherId) ||
      String(session.substituteTeacher?._id || "") === String(teacherId);
    if (!isAssigned) {
      return res.status(403).json({ success: false, message: "You are not assigned to this class" });
    }

    if (session.status === "cancelled") {
      return res.status(400).json({ success: false, message: "This class is cancelled" });
    }

    // If the meeting was never generated, regenerate now (graceful).
    if (!session.meetingLink) {
      const updated = await regenerateMeeting(session._id, { actor: teacherId });
      session.meetingLink = updated.meetingLink;
      session.meetingStatus = updated.meetingStatus;
    }

    // Mark live.
    await ClassSession.findByIdAndUpdate(session._id, { status: "live" });
    emitToAdmin("class:live", { sessionId: session._id });

    res.json({
      success: true,
      session: { sessionId: session._id, status: "live" },
      meeting: { status: session.meetingStatus, link: session.meetingLink || "" },
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});
// ---------------------------------------------------------------------------
// QAO/Admin: view attendance for a session (aggregated + individual).
// Gated by role — never exposed via a public list endpoint.
// ---------------------------------------------------------------------------
router.get("/:sessionId/attendance", verifyQao, async (req, res) => {
  try {
    const list = await listAttendance(req.params.sessionId);
    res.json({
      success: true,
      count: list.length,
      attendance: list.map((a) => ({
        student: {
          id: String(a.student?._id || ""),
          name: a.student?.fullName || "",
          email: a.student?.email || "",
        },
        joinedAt: a.joinedAt,
        leftAt: a.leftAt,
        duration: a.duration,
        source: a.source,
      })),
    });
  } catch (err) {
    res.status(err.message === "Session not found" ? 404 : 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// QAO: regenerate a meeting link for a session.
// POST /api/meet/:sessionId/regenerate
// ---------------------------------------------------------------------------
router.post("/:sessionId/regenerate", verifyQao, async (req, res) => {
  try {
    const updated = await regenerateMeeting(req.params.sessionId, { actor: req.user?._id });
    res.json({
      success: true,
      session: {
        sessionId: updated._id,
        meetingStatus: updated.meetingStatus,
        meetingProvider: updated.meetingProvider,
        meetingLink: updated.meetingLink,
      },
    });
  } catch (err) {
    res.status(err.message === "Session not found" ? 404 : 500).json({ success: false, message: err.message });
  }
});

// Admin-only alias for the admin surface.
router.post("/admin/:sessionId/regenerate", adminAuth, async (req, res) => {
  try {
    const actor = req.admin?.id || req.user?._id || null;
    const updated = await regenerateMeeting(req.params.sessionId, { actor });
    res.json({
      success: true,
      session: {
        sessionId: updated._id,
        meetingStatus: updated.meetingStatus,
        meetingProvider: updated.meetingProvider,
        meetingLink: updated.meetingLink,
      },
    });
  } catch (err) {
    res.status(err.message === "Session not found" ? 404 : 500).json({ success: false, message: err.message });
  }
});

// ===========================================================================
// Phase 6 additions: aliases, teacher console, QAO live ops, admin force ops,
// analytics exports, Google settings status, recordings.
// ===========================================================================

// ---- Teacher console (Phase 6B) -------------------------------------------
// End a class the teacher owns.
router.post("/teacher/:sessionId/end", verifyTeacher, async (req, res) => {
  try {
    const teacherId = req.user._id;
    const session = await loadSession(req.params.sessionId);
    const isAssigned =
      String(session.teacher?._id || "") === String(teacherId) ||
      String(session.substituteTeacher?._id || "") === String(teacherId);
    if (!isAssigned) {
      return res.status(403).json({ success: false, message: "You are not assigned to this class" });
    }
    const { endSession } = await import("../services/qao/scheduling.service.js");
    const updated = await endSession(session._id, { actor: teacherId, forced: false });
    res.json({ success: true, session: { sessionId: updated._id, status: updated.status } });
  } catch (err) {
    res.status(err.statusCode || 400).json({ success: false, message: err.message });
  }
});

// Regenerate the meeting link for a class the teacher owns.
router.post("/teacher/:sessionId/regenerate", verifyTeacher, async (req, res) => {
  try {
    const teacherId = req.user._id;
    const session = await loadSession(req.params.sessionId);
    const isAssigned =
      String(session.teacher?._id || "") === String(teacherId) ||
      String(session.substituteTeacher?._id || "") === String(teacherId);
    if (!isAssigned) {
      return res.status(403).json({ success: false, message: "You are not assigned to this class" });
    }
    const updated = await regenerateMeeting(session._id, { actor: teacherId });
    res.json({ success: true, session: { sessionId: updated._id, meetingStatus: updated.meetingStatus, meetingLink: updated.meetingLink } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

// Attendance list for the teacher's own class.
router.get("/teacher/:sessionId/attendance", verifyTeacher, async (req, res) => {
  try {
    const teacherId = req.user._id;
    const session = await loadSession(req.params.sessionId);
    const isAssigned =
      String(session.teacher?._id || "") === String(teacherId) ||
      String(session.substituteTeacher?._id || "") === String(teacherId);
    if (!isAssigned) {
      return res.status(403).json({ success: false, message: "You are not assigned to this class" });
    }
    const list = await listAttendance(session._id);
    res.json({
      success: true,
      count: list.length,
      attendance: list.map((a) => ({
        student: { id: String(a.student?._id || ""), name: a.student?.fullName || "" },
        joinedAt: a.joinedAt, leftAt: a.leftAt, duration: a.duration, source: a.source,
      })),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
});

// Recording: teacher/admin set or update the recording link (Phase 6K).
router.patch("/:sessionId/recording", verifyTeacher, async (req, res) => {
  try {
    const teacherId = req.user._id;
    const session = await ClassSession.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    const isAssigned = String(session.teacher || "") === String(teacherId) ||
      String(session.substituteTeacher || "") === String(teacherId);
    if (!isAssigned) return res.status(403).json({ success: false, message: "Not allowed" });
    session.recordingLink = String(req.body?.recordingLink || "").trim();
    await session.save();
    const { syncClassSession, CLASS_SYNC_ACTIONS } = await import("../services/moodle/syncClass.js");
    try { await syncClassSession(session, { action: CLASS_SYNC_ACTIONS.UPDATED }); } catch { /* non-fatal */ }
    res.json({ success: true, recordingLink: session.recordingLink });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- QAO Live Operations Center (Phase 6C) ---------------------------------
// Aggregated monitoring only — counts and class/teacher info, NEVER student PII.
router.get("/qao/live-ops", verifyQao, async (req, res) => {
  try {
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const [live, upcoming, pending, failed, teacherCounts, attendanceAgg] = await Promise.all([
      ClassSession.countDocuments({ status: "live" }),
      ClassSession.countDocuments({ status: "scheduled", date: { $gte: dayStart, $lt: dayEnd } }),
      ClassSession.countDocuments({ meetingStatus: "pending", status: { $in: ["scheduled", "live"] } }),
      ClassSession.countDocuments({ meetingStatus: "failed" }),
      (async () => {
        const Teacher = (await import("../models/teacher.js")).default;
        const total = await Teacher.countDocuments({ employmentStatus: { $ne: "former" } });
        const liveTeachers = await ClassSession.distinct("teacher", { status: "live" });
        const liveSubs = await ClassSession.distinct("substituteTeacher", { status: "live" });
        const online = new Set([...liveTeachers, ...liveSubs].filter(Boolean).map(String)).size;
        return { online, offline: Math.max(total - online, 0), total };
      })(),
      ClassSession.aggregate([
        { $match: { status: { $in: ["live", "completed"] } } },
        { $project: { joined: { $size: { $ifNull: ["$attendance", []] } } } },
        { $group: { _id: null, joins: { $sum: "$joined" }, sessions: { $sum: 1 } } },
      ]),
    ]);

    const att = attendanceAgg[0] || { joins: 0, sessions: 0 };
    res.json({
      success: true,
      ops: {
        liveClasses: live,
        upcomingToday: upcoming,
        teachersOnline: teacherCounts.online,
        teachersOffline: teacherCounts.offline,
        teachersTotal: teacherCounts.total,
        studentsJoined: att.joins,
        attendanceRate: att.sessions ? Math.round((att.joins / att.sessions) * 1000) / 10 : 0,
        meetingPending: pending,
        meetingFailed: failed,
        googleApiErrors: failed,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- Analytics + exports (Phase 6H) ----------------------------------------
router.get("/qao/virtual-analytics", verifyQao, async (req, res) => {
  try {
    const { getVirtualAnalytics } = await import("../services/qao/reports.service.js");
    // includeStudents=false for QAO: no student PII.
    res.json({ success: true, analytics: await getVirtualAnalytics({ from: req.query.from, to: req.query.to, includeStudents: false }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/qao/virtual-analytics/export", verifyQao, async (req, res) => {
  try {
    const { getVirtualAnalytics } = await import("../services/qao/reports.service.js");
    const analytics = await getVirtualAnalytics({ from: req.query.from, to: req.query.to, includeStudents: false });
    const rows = [
      { Metric: "Total classes", Value: analytics.totals.classes },
      { Metric: "Completed", Value: analytics.totals.completed },
      { Metric: "Cancelled", Value: analytics.totals.cancelled },
      { Metric: "Meeting success rate %", Value: analytics.meeting.successRate },
      { Metric: "Join rate %", Value: analytics.attendance.joinRate },
      { Metric: "Late rate %", Value: analytics.attendance.lateRate },
      { Metric: "Avg duration (min)", Value: analytics.attendance.avgDurationMinutes },
    ];
    const headers = ["Metric", "Value"];
    if (req.query.format === "pdf") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(exporter.toPrintHtml({ title: "Virtual Classroom Analytics", subtitle: "StudiesMasters Tutor Manager", headers, rows }));
    } else {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=virtual-analytics.csv");
      res.send(exporter.csvBuffer(exporter.toCsv(headers, rows)));
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- Admin Operations Center (Phase 6D) ------------------------------------
// Master schedule + daily/weekly/monthly stats.
router.get("/admin/overview", adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(dayStart); monthStart.setMonth(monthStart.getMonth() - 1);

    const count = (from) => ClassSession.countDocuments(from ? { date: { $gte: from } } : {});
    const [total, daily, weekly, monthly, live, pending, failed] = await Promise.all([
      count(null), count(dayStart), count(weekStart), count(monthStart),
      ClassSession.countDocuments({ status: "live" }),
      ClassSession.countDocuments({ meetingStatus: "pending", status: { $in: ["scheduled", "live"] } }),
      ClassSession.countDocuments({ meetingStatus: "failed" }),
    ]);

    const sessions = await ClassSession.find().sort({ date: -1 }).limit(50)
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .populate("substituteTeacher", "fullName")
      .lean();
    const { stageFor } = await import("../services/qao/lifecycle.service.js");
    res.json({
      success: true,
      stats: { total, daily, weekly, monthly, live, meetingPending: pending, meetingFailed: failed },
      sessions: sessions.map((s) => ({
        sessionId: s._id,
        subject: s.classGroup?.subject || "", grade: s.classGroup?.grade || "",
        curriculum: s.classGroup?.curriculum || "",
        teacher: s.teacher?.fullName || "", substitute: s.substituteTeacher?.fullName || "",
        date: s.date, startTime: s.startTime, endTime: s.endTime,
        status: s.status, meetingStatus: s.meetingStatus, stage: stageFor(s, new Date()),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Every force action: requires a reason, writes an AuditLog, notifies QAO.
async function forceAction(req, res, kind) {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "reason is required for a force action" });
    const adminId = req.admin?.id || null;
    const sched = await import("../services/qao/scheduling.service.js");
    const session = await ClassSession.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    let result = {};
    if (kind === "force-start") {
      session.status = "live";
      await session.save();
    } else if (kind === "force-end") {
      await sched.endSession(session._id, { actor: adminId, forced: true });
    } else if (kind === "force-cancel") {
      session.status = "cancelled";
      await session.save();
    } else if (kind === "force-create-meeting") {
      const updated = await regenerateMeeting(session._id, { actor: adminId });
      result = { meetingStatus: updated.meetingStatus, meetingLink: updated.meetingLink };
    } else if (kind === "force-replace-teacher") {
      await sched.replaceSessionTeacher(session._id, { teacher: req.body?.teacher, reason, override: true, actor: adminId });
    }

    await sched.logQaoAction({
      action: `admin.${kind}`,
      resource: "ClassSession",
      resourceId: session._id,
      details: { reason, adminId, kind },
    });
    emitToQaos("notification:new", { title: `Admin ${kind.replace("force-", "")}`, message: `Session ${session._id}: ${reason}`, type: "alert" });

    res.json({ success: true, sessionId: session._id, action: kind, reason, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
}

router.post("/admin/:sessionId/force-start", adminAuth, (req, res) => forceAction(req, res, "force-start"));
router.post("/admin/:sessionId/force-end", adminAuth, (req, res) => forceAction(req, res, "force-end"));
router.post("/admin/:sessionId/force-cancel", adminAuth, (req, res) => forceAction(req, res, "force-cancel"));
router.post("/admin/:sessionId/force-create-meeting", adminAuth, (req, res) => forceAction(req, res, "force-create-meeting"));
router.post("/admin/:sessionId/force-replace-teacher", adminAuth, (req, res) => forceAction(req, res, "force-replace-teacher"));

// Google Workspace settings status — MASKED, never returns secrets (Phase 6J).
router.get("/admin/google-status", adminAuth, async (req, res) => {
  try {
    const { config, isConfiguredReal } = await import("../services/google/config.js");
    const GoogleToken = (await import("../models/GoogleToken.js")).default;
    const mask = (v) => (v ? `${String(v).slice(0, 6)}••••••${String(v).slice(-4)}` : "");
    const token = await GoogleToken.findOne({ provider: "google" }).sort({ updatedAt: -1 }).lean();
    res.json({
      success: true,
      settings: {
        enabled: config.enabled,
        allowMock: config.allowMock,
        clientId: mask(config.clientId),
        clientSecret: mask(config.clientSecret),
        redirectUri: config.redirectUri,
        timezone: config.timezone,
        oauthConfigured: isConfiguredReal(),
        tokenStatus: token ? { hasRefreshToken: Boolean(token.encryptedRefreshToken), expiresAt: token.expiresAt, scope: token.scope } : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Connection test: attempts a real (or mock) meeting generation without saving.
router.post("/admin/google-status/test-connection", adminAuth, async (req, res) => {
  try {
    const { createMeeting } = await import("../services/google/meet.service.js");
    const probe = await createMeeting({
      subject: "Google Workspace connection test",
      date: new Date(), startTime: "00:00", endTime: "00:01", sessionId: "probe",
    });
    res.json({
      success: true,
      mode: probe.mock ? "mock" : "live",
      meetingStatus: probe.meetingStatus,
      message: probe.mock
        ? "Mock mode: configure real GOOGLE_CLIENT_* credentials and set GOOGLE_ALLOW_MOCK=false for live generation."
        : "Live Google Calendar connection OK.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- Admin analytics (with student names — admin surface only) -------------
router.get("/admin/virtual-analytics", adminAuth, async (req, res) => {
  try {
    const { getVirtualAnalytics } = await import("../services/qao/reports.service.js");
    res.json({ success: true, analytics: await getVirtualAnalytics({ from: req.query.from, to: req.query.to, includeStudents: true }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;