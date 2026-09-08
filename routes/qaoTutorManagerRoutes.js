// routes/qaoTutorManagerRoutes.js
//
// Tutor Manager (QAO) dashboard endpoints. Mounted from qaoRoutes.js so every
// path below lives under /api/qao/*. All routes are verifyQao-gated and every
// response passes through the QAO sanitizer: no student records, ObjectIds or
// PII ever leave the server.
import { Router } from "express";

import Timetable from "../models/Timetable.js";
import Subject from "../models/Subject.js";
import Broadcast from "../models/Broadcast.js";

import { verifyQao } from "../middleware/verifyQao.js";
import { sanitizeClassGroup, sanitizeTeacher, TEACHER_SAFE_PROJECTION } from "../services/qao/sanitize.js";
import * as dashboard from "../services/qao/dashboard.service.js";
import * as teachers from "../services/qao/teacher.service.js";
import * as groups from "../services/qao/classGroup.service.js";
import * as scheduling from "../services/qao/scheduling.service.js";
import * as reports from "../services/qao/reports.service.js";
import { emitToQaos } from "../services/qao/notify.js";
import * as availability from "../services/qao/availability.service.js";
import * as leave from "../services/qao/leave.service.js";
import * as workloadSvc from "../services/qao/workload.service.js";
import * as matching from "../services/qao/teacherMatching.service.js";
import * as perf from "../services/qao/performance.service.js";
import * as auditSvc from "../services/qao/audit.service.js";
import * as notif from "../services/qao/notification.service.js";
import * as exporter from "../services/qao/export.service.js";
import { logQaoAction } from "../services/qao/audit.service.js";

const router = Router();

// -------------------- Overview --------------------
router.get("/overview", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, overview: await dashboard.getOverview() });
  } catch (err) {
    console.error("QAO overview error:", err);
    res.status(500).json({ success: false, message: "Failed to load overview" });
  }
});

// -------------------- Teachers --------------------
router.get("/teachers/all", verifyQao, async (req, res) => {
  try {
    const filter = {};
    if (req.query.employmentStatus) filter.employmentStatus = req.query.employmentStatus;
    if (req.query.curriculum) filter.curriculum = req.query.curriculum;
    res.json({ success: true, teachers: await teachers.listTeachers(filter) });
  } catch (err) {
    console.error("QAO list teachers error:", err);
    res.status(500).json({ success: false, message: "Failed to load teachers" });
  }
});

router.get("/teachers/:id", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, teacher: await teachers.getTeacherById(req.params.id) });
  } catch (err) {
    res.status(err.message === "Teacher not found" ? 404 : 500).json({ success: false, message: err.message });
  }
});

router.patch("/teachers/:id", verifyQao, async (req, res) => {
  try {
    const teacher = await teachers.updateTeacher(req.params.id, req.body);
    res.json({ success: true, teacher });
  } catch (err) {
    res.status(err.message === "Teacher not found" ? 404 : 400).json({ success: false, message: err.message });
  }
});

// -------------------- Class Groups (QAO-safe) --------------------
router.get("/class-groups/all", verifyQao, async (req, res) => {
  try {
    const filter = {};
    if (req.query.curriculum) filter.curriculum = req.query.curriculum;
    if (req.query.status) filter.status = req.query.status;
    res.json({ success: true, groups: await groups.listClassGroups(filter) });
  } catch (err) {
    console.error("QAO list groups error:", err);
    res.status(500).json({ success: false, message: "Failed to load class groups" });
  }
});

router.post("/class-groups", verifyQao, async (req, res) => {
  try {
    const group = await groups.createClassGroup(req.body);
    res.status(201).json({ success: true, group });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.patch("/class-groups/:id", verifyQao, async (req, res) => {
  try {
    const group = await groups.updateClassGroup(req.params.id, req.body);
    res.json({ success: true, group });
  } catch (err) {
    res.status(err.message === "Class group not found" ? 404 : 400).json({ success: false, message: err.message });
  }
});

// -------------------- Timetable Approvals (unchanged model) --------------------
router.get("/timetables", verifyQao, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const timetables = await Timetable.find(filter)
      .populate("teacherId", TEACHER_SAFE_PROJECTION)
      .populate("subjectId", "name curriculum grade")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, timetables: timetables.map((t) => sanitizeTeacher(t)) });
  } catch (err) {
    console.error("QAO list timetables error:", err);
    res.status(500).json({ success: false, message: "Failed to load timetables" });
  }
});

router.patch("/timetables/:id", verifyQao, async (req, res) => {
  try {
    const { status, feedback } = req.body;
    if (status && !["Pending", "Approved", "Flagged"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid timetable status" });
    }
    const timetable = await Timetable.findByIdAndUpdate(
      req.params.id,
      { ...(status ? { status } : {}), ...(feedback !== undefined ? { feedback } : {}) },
      { new: true }
    )
      .populate("teacherId", TEACHER_SAFE_PROJECTION)
      .lean();
    if (!timetable) return res.status(404).json({ success: false, message: "Timetable not found" });
    emitToQaos("timetable:reviewed", { timetableId: timetable._id, status: timetable.status });
    res.json({ success: true, timetable: sanitizeTeacher(timetable) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// -------------------- Announcements / Broadcast history --------------------
router.get("/broadcasts", verifyQao, async (req, res) => {
  try {
    const broadcasts = await Broadcast.find({ type: { $in: ["teachers", "tutormanagers", "all", "single"] } })
      .populate("sender", "name fullName email")
      .populate("teacher", "fullName email")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, broadcasts });
  } catch (err) {
    console.error("QAO broadcasts error:", err);
    res.status(500).json({ success: false, message: "Failed to load broadcasts" });
  }
});

// Tutor-manager announcement recorded in the shared Broadcast history with
// senderModel = QaoUser (see models/Broadcast.js polymorphic sender).
router.post("/announcements", verifyQao, async (req, res) => {
  try {
    const { subject, message, type } = req.body;
    if (!message) return res.status(400).json({ success: false, message: "Message is required" });
    const announcement = await Broadcast.create({
      sender: req.user._id,
      senderModel: "QaoUser",
      type: ["teachers", "tutormanagers", "all"].includes(type) ? type : "teachers",
      subject: subject || "Announcement",
      message,
    });
    emitToQaos("announcement:new", { id: announcement._id, subject: announcement.subject });
    res.status(201).json({ success: true, announcement });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// -------------------- Search (teachers / groups / subjects only) --------------------
router.get("/search", verifyQao, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json({ success: true, teachers: [], groups: [], subjects: [] });
    }
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const [teacherHits, groupHits, subjectHits] = await Promise.all([
      teachers.listTeachers({ $or: [{ fullName: rx }, { name: rx }, { email: rx }, { curriculum: rx }] }),
      groups.listClassGroups({ $or: [{ code: rx }, { subject: rx }, { curriculum: rx }, { grade: rx }] }),
      Subject.find({ $or: [{ name: rx }, { curriculum: rx }, { grade: rx }] }).select("name curriculum grade package").lean(),
    ]);
    res.json({ success: true, teachers: teacherHits.slice(0, 20), groups: groupHits.slice(0, 20), subjects: subjectHits.slice(0, 20) });
  } catch (err) {
    console.error("QAO search error:", err);
    res.status(500).json({ success: false, message: "Search failed" });
  }
});

// -------------------- Scheduling engine (ClassSession) --------------------
router.get("/sessions", verifyQao, async (req, res) => {
  try {
    const sessions = await scheduling.listSessions({
      from: req.query.from,
      to: req.query.to,
      teacherId: req.query.teacherId,
      classGroupId: req.query.classGroupId,
      status: req.query.status,
    });
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/sessions/today", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, sessions: await scheduling.todaySessions() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/sessions", verifyQao, async (req, res) => {
  try {
    const session = await scheduling.createSession(req.body);
    res.status(201).json({ success: true, session });
  } catch (err) {
    if (err.conflictWith || err.conflictType) emitToQaos("schedule:conflict", { message: err.message, type: err.conflictType });
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

router.patch("/sessions/:id", verifyQao, async (req, res) => {
  try {
    const session = await scheduling.updateSession(req.params.id, req.body);
    res.json({ success: true, session });
  } catch (err) {
    if (err.conflictWith || err.conflictType) emitToQaos("schedule:conflict", { message: err.message, type: err.conflictType });
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

// -------------------- Reports / Analytics --------------------
router.get("/reports", verifyQao, async (req, res) => {
  try {
    res.json({
      success: true,
      reports: await reports.getReports({ from: req.query.from, to: req.query.to }),
    });
  } catch (err) {
    console.error("QAO reports error:", err);
    res.status(500).json({ success: false, message: "Failed to generate reports" });
  }
});
// -------------------- Virtual Class Analytics --------------------
router.get("/virtual-class-metrics", verifyQao, async (req, res) => {
  try {
    res.json({
      success: true,
      metrics: await reports.getVirtualClassMetrics({ from: req.query.from, to: req.query.to }),
    });
  } catch (err) {
    console.error("QAO virtual class metrics error:", err);
    res.status(500).json({ success: false, message: "Failed to load virtual class analytics" });
  }
});

router.delete("/sessions/:id", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, ...(await scheduling.deleteSession(req.params.id)) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});


// ==================== Phase 3: Teacher Operations ====================

// ---- Teacher availability management ----
router.get("/teachers/:id/availability", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, availability: await availability.getAvailability(req.params.id) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

router.post("/teachers/:id/availability", verifyQao, async (req, res) => {
  try {
    const slot = await availability.addSlot(req.params.id, req.body);
    res.status(201).json({ success: true, slot });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

router.patch("/teachers/:id/availability/:slotId", verifyQao, async (req, res) => {
  try {
    const slot = await availability.updateSlot(req.params.id, req.params.slotId, req.body);
    res.json({ success: true, slot });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

router.delete("/teachers/:id/availability/:slotId", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, ...(await availability.deleteSlot(req.params.id, req.params.slotId)) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

// ---- Leave requests (QAO review workflow) ----
router.get("/leave-requests", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, requests: await leave.listRequests({ status: req.query.status, teacherId: req.query.teacherId }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/leave-requests/:id", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, request: await leave.getRequest(req.params.id) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 500).json({ success: false, message: err.message });
  }
});

// QAO may submit a leave request on behalf of a teacher
router.post("/leave-requests", verifyQao, async (req, res) => {
  try {
    const { teacherId, leaveType, startDate, endDate, reason } = req.body;
    const request = await leave.submitRequest({ teacherId, leaveType, startDate, endDate, reason, submittedBy: "qao" });
    res.status(201).json({ success: true, request });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Approve / reject with review note. Approval returns the impact analysis.
router.patch("/leave-requests/:id", verifyQao, async (req, res) => {
  try {
    const result = await leave.reviewRequest(req.params.id, req.body, req.user._id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

router.delete("/leave-requests/:id", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, ...(await leave.deleteRequest(req.params.id)) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

// ---- Workload dashboard ----
router.get("/workload", verifyQao, async (req, res) => {
  try {
    const workload = await workloadSvc.getWorkload();
    res.json({ success: true, workload, thresholds: workloadSvc.WORKLOAD_THRESHOLDS });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- Smart teacher matching ----
router.get("/class-groups/:id/teacher-suggestions", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, ...(await matching.suggestForGroup(req.params.id, { date: req.query.date, startTime: req.query.startTime, endTime: req.query.endTime })) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 500).json({ success: false, message: err.message });
  }
});

router.get("/sessions/:id/substitute-suggestions", verifyQao, async (req, res) => {
  try {
    const session = await (await import("../models/ClassSession.js")).default.findById(req.params.id)
      .populate("classGroup", "code curriculum grade subject")
      .lean();
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    res.json({ success: true, suggestions: await matching.suggestForSession(session) });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 500).json({ success: false, message: err.message });
  }
});

// ---- Reports additions ----
router.get("/reports/leave", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, report: await leave.leaveReport() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/reports/availability", verifyQao, async (req, res) => {
  try {
    res.json({ success: true, report: await availability.availabilityReport() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== Phase 4: Intelligence & Operations ====================

// ---- Teacher performance / snapshots ----
router.get("/performance", verifyQao, async (req, res) => {
  try {
    const month = req.query.month || perf.monthKey();
    const teacherId = req.query.teacherId || null;
    const stats = await perf.getMonthlyStatistics({ month, teacherId });
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/performance/generate", verifyQao, async (req, res) => {
  try {
    const month = req.query.month || perf.monthKey();
    const result = await perf.generateSnapshot({ month });
    await logQaoAction({ action: "PERFORMANCE_SNAPSHOT_GENERATED", resource: "TeacherPerformanceSnapshot", details: { month } });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/performance/snapshots", verifyQao, async (req, res) => {
  try {
    const snapshots = await perf.listSnapshots({ teacherId: req.query.teacherId || null, limit: req.query.limit || 12 });
    res.json({ success: true, snapshots });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- Persistent notification center (QAO role) ----
router.get("/notifications/center", verifyQao, async (req, res) => {
  try {
    const items = await notif.listForQao({ limit: req.query.limit || 50 });
    const unread = await notif.unreadCountQao();
    res.json({ success: true, notifications: items, unread });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/notifications/:id/read", verifyQao, async (req, res) => {
  try {
    const n = await notif.markReadQao(req.params.id);
    res.json({ success: true, notification: n });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

router.patch("/notifications/read-all", verifyQao, async (req, res) => {
  try {
    await notif.markAllReadQao();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- Audit logs (QAO actions) ----
router.get("/audit-logs", verifyQao, async (req, res) => {
  try {
    const result = await auditSvc.listQaoAuditLogs({ limit: req.query.limit, offset: req.query.offset, action: req.query.action });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---- Data export (no student PII) ----
router.get("/export/performance", verifyQao, async (req, res) => {
  try {
    const month = req.query.month || perf.monthKey();
    const stats = await perf.getMonthlyStatistics({ month, teacherId: req.query.teacherId || null });
    const headers = ["Teacher", "Curriculum", "Completed", "Cancelled", "Substituted", "Hours", "CancellationRate", "Workload"];
    const rows = stats.rows.map((r) => ({
      Teacher: r.name,
      Curriculum: r.curriculum || "",
      Completed: r.completedClasses,
      Cancelled: r.cancelledClasses,
      Substituted: r.substitutedClasses,
      Hours: r.teachingHours,
      CancellationRate: r.cancellationRate + "%",
      Workload: r.workloadLevel,
    }));
    if (req.query.format === "pdf") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(exporter.toPrintHtml({ title: "Teacher Performance - " + month, subtitle: "StudiesMasters Tutor Manager", headers, rows }));
    } else {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=performance-" + month + ".csv");
      res.send(exporter.csvBuffer(exporter.toCsv(headers, rows)));
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/export/sessions", verifyQao, async (req, res) => {
  try {
    const sessions = await scheduling.listSessions({ from: req.query.from, to: req.query.to, teacherId: req.query.teacherId, classGroupId: req.query.classGroupId, status: req.query.status });
    const headers = ["Date", "Start", "End", "Curriculum", "Grade", "Subject", "Teacher", "Status", "DurationMin"];
    const rows = sessions.map((s) => ({
      Date: new Date(s.date).toISOString().slice(0, 10),
      Start: s.startTime,
      End: s.endTime,
      Curriculum: s.classGroup?.curriculum || "",
      Grade: s.classGroup?.grade || "",
      Subject: s.classGroup?.subject || "",
      Teacher: s.teacher?.fullName || (s.classGroup?.teacher?.fullName || ""),
      Status: s.status,
      DurationMin: s.durationMinutes || 0,
    }));
    if (req.query.format === "pdf") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(exporter.toPrintHtml({ title: "Class Sessions", subtitle: "StudiesMasters Tutor Manager", headers, rows }));
    } else {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=sessions.csv");
      res.send(exporter.csvBuffer(exporter.toCsv(headers, rows)));
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
