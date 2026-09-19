// routes/moodleRoutes.js
// HTTP surface for StudiesMasters <-> Moodle. All Moodle business logic lives in
// services/moodle/* (the backend is the only authority). This file only handles
// auth, validation, rate limiting, and response shaping.
import express from "express";
import rateLimit from "express-rate-limit";
import { studentAuth } from "../middleware/studentAuth.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import { adminAuth } from "../middleware/adminAuth.js";
import {
  generateSSO, verifySSO, syncProfile, enrollUser, unenrollUser,
  suspendUser, runReconciliation, listMappings, upsertMapping, removeMapping,
  provisionStructure, provisionStatus, syncAllStudents, syncAllTeachers, queueSnapshot,
  resolveStudentAccess, syncOverview, listWarnings, retryFailedSyncs,
} from "../services/moodle/index.js";

const router = express.Router();
const ok = (res, data = {}) => res.json({ success: true, ...data });
const fail = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

// ---- Rate limiting (global + per-user/IP + admin burst) ------------------
const moodleGlobal = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const ssoLimiter = rateLimit({
  windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.user?._id || "anon"}`,
});
const adminLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
router.use(moodleGlobal);

// ---- SSO issue (keeps the existing frontend contract { url }) ---------------
router.get("/sso", ssoLimiter, studentAuth, async (req, res) => {
  try {
    const { url } = await generateSSO({ role: "student", id: req.user._id, email: req.user.email, fullName: req.user.fullName, course: req.query.course, req });
    return ok(res, { url });
  } catch (err) { console.error("Student SSO error:", err); return fail(res, 500, "Unable to create SSO link"); }
});
router.get("/teacher-sso", ssoLimiter, verifyTeacher, async (req, res) => {
  try {
    const { url } = await generateSSO({ role: "teacher", id: req.user._id, email: req.user.email, fullName: req.user.fullName, course: req.query.course, req });
    return ok(res, { url });
  } catch (err) { console.error("Teacher SSO error:", err); return fail(res, 500, "Could not create SSO."); }
});

// ---- SSO verification consumed by the Moodle plugin (sso.php) --------------
// No JWT; the signed params are the credentials. Identity/profile is resolved
// freshly from Mongo here — the plugin never trusts the URL payload.
router.get("/sso/verify", async (req, res) => {
  const verdict = await verifySSO({ username: req.query.username, email: req.query.email, timestamp: req.query.timestamp, nonce: req.query.nonce, course: req.query.course, signature: req.query.signature, req });
  if (!verdict.ok) return res.status(401).json({ success: false, reason: verdict.reason });
  return res.json({ success: true, ...verdict });
});

// ---- Main website name sync (studiesmasters_mainwebsite_sync) --------------
// Called by the Moodle SSO plugin (sso.php) during SSO login when the main
// website sync URL + token are configured. Returns the real user name from the
// StudiesMasters main website so Moodle user names stay current.
// The plugin calls this as a GET with query params (email + token); token-gated.
router.get("/main-website/sync-name", async (req, res) => {
  try {
    const { email, token } = req.query || {};
    if (!email) return fail(res, 400, "email is required");
    const config = await import("../services/moodle/config.js");
    const expectedToken = config.default?.mainWebsiteSyncToken;
    if (expectedToken && token !== expectedToken) {
      return fail(res, 401, "invalid token");
    }
    const { syncMainWebsiteName } = await import("../services/moodle/syncMainWebsiteName.js");
    return ok(res, await syncMainWebsiteName({ email, req }));
  } catch (err) {
    console.error("Main website sync-name error:", err);
    return fail(res, 500, "Name sync failed");
  }
});

// ---- Timetable / live-class sync (stock Moodle calendar events) ------------
// Students push their week into their own Moodle calendar (so Moodle is the
// place they access live classes); admins can bulk re-push live classes.
router.post("/sync/timetable", ssoLimiter, studentAuth, async (req, res) => {
  try {
    const { syncTimetableForStudent } = await import("../services/moodle/syncTimetable.js");
    return ok(res, await syncTimetableForStudent({ studentId: req.user._id, req }));
  } catch (err) { return fail(res, 502, "Timetable sync failed", { error: err.message }); }
});
router.post("/sync/teacher-timetable", ssoLimiter, verifyTeacher, async (req, res) => {
  try {
    const { syncTimetableForTeacher } = await import("../services/moodle/syncTimetable.js");
    return ok(res, await syncTimetableForTeacher({ teacherId: req.user._id, req }));
  } catch (err) { return fail(res, 502, "Teacher timetable sync failed", { error: err.message }); }
});
router.post("/sync/timetable/:studentId", adminLimiter, adminAuth, async (req, res) => {
  try {
    const { syncTimetableForStudent } = await import("../services/moodle/syncTimetable.js");
    return ok(res, await syncTimetableForStudent({
      studentId: req.params.studentId,
      from: req.body?.from || null,
      to: req.body?.to || null,
      req,
    }));
  } catch (err) { return fail(res, 502, "Timetable sync failed", { error: err.message }); }
});
router.post("/sync/class-group/:id", adminLimiter, adminAuth, async (req, res) => {
  try {
    const { syncClassGroupEnrollment } = await import("../services/moodle/syncTimetable.js");
    return ok(res, await syncClassGroupEnrollment({ classGroupId: req.params.id, req }));
  } catch (err) { return fail(res, 502, "Class group sync failed", { error: err.message }); }
});
router.post("/sync/live-classes", adminLimiter, adminAuth, async (req, res) => {
  try {
    const { syncLiveClasses } = await import("../services/moodle/syncTimetable.js");
    return ok(res, await syncLiveClasses({ from: req.body?.from || null, to: req.body?.to || null }));
  } catch (err) { return fail(res, 502, "Live class sync failed", { error: err.message }); }
});

// ---- Health / availability (read-only, unauthenticated) ------------------
router.get("/health", async (req, res) => {
  try {
    const { health } = await import("../services/moodle/metrics.js");
    return ok(res, await health());
  } catch (err) { return fail(res, 500, "Health check failed", { error: err.message }); }
});

// ---- Admin: backend-authoritative account lifecycle ----------------------
router.post("/sync", adminLimiter, adminAuth, async (req, res) => {
  const { id, role = "student" } = req.body || {};
  if (!id) return fail(res, 400, "id is required");
  try { return ok(res, await syncProfile({ id, role, req })); }
  catch (err) { return fail(res, 502, "Moodle sync failed.", { error: err.message }); }
});
router.post("/enroll", adminLimiter, adminAuth, async (req, res) => {
  const { id, role = "student", courseIds } = req.body || {};
  if (!id) return fail(res, 400, "id is required");
  try { return ok(res, await enrollUser({ role, id, courseIds, req })); }
  catch (err) { return fail(res, 502, "Moodle enroll failed.", { error: err.message }); }
});
router.post("/unenroll", adminLimiter, adminAuth, async (req, res) => {
  const { id, role = "student", courseIds = [] } = req.body || {};
  if (!id || !courseIds.length) return fail(res, 400, "id and courseIds are required");
  try { return ok(res, await unenrollUser({ id, role, courseIds, req })); }
  catch (err) { return fail(res, 502, "Moodle unenroll failed.", { error: err.message }); }
});
router.post("/suspend", adminLimiter, adminAuth, async (req, res) => {
  const { id, role = "student" } = req.body || {};
  if (!id) return fail(res, 400, "id is required");
  try { return ok(res, await suspendUser({ id, role, suspended: true, req })); }
  catch (err) { return fail(res, 502, "Suspend failed.", { error: err.message }); }
});
router.post("/reactivate", adminLimiter, adminAuth, async (req, res) => {
  const { id, role = "student" } = req.body || {};
  if (!id) return fail(res, 400, "id is required");
  try { return ok(res, await suspendUser({ id, role, suspended: false, req })); }
  catch (err) { return fail(res, 502, "Reactivate failed.", { error: err.message }); }
});
router.post("/sync/reconcile", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await runReconciliation({ limit: req.body?.limit || 200 })); }
  catch (err) { return fail(res, 502, "Reconciliation failed.", { error: err.message }); }
});

// ---- Audit log stream -----------------------------------------------------
router.get("/audit", adminLimiter, adminAuth, async (req, res) => {
  const MoodleAuditLog = (await import("../models/MoodleAuditLog.js")).default;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const filter = {};
  if (req.query.action) filter.action = req.query.action;
  if (req.query.studentId) filter.studentRef = req.query.studentId;
  const [logs, total] = await Promise.all([
    MoodleAuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    MoodleAuditLog.countDocuments(filter),
  ]);
  return ok(res, { logs, pagination: { page, limit, total } });
});

// ---- Course mapping CRUD (runtime-configurable) ---------------------------
router.get("/course-mappings", adminLimiter, adminAuth, async (req, res) => ok(res, { mappings: await listMappings() }));
router.post("/course-mappings", adminLimiter, adminAuth, async (req, res) => {
  const { subjectName, packageName, curriculum, grade, targets } = req.body || {};
  if (!subjectName) return fail(res, 400, "subjectName is required");
  const mapping = await upsertMapping({ subjectName, packageName, curriculum, grade, targets });
  return ok(res, { mapping });
});
router.delete("/course-mappings/:id", adminLimiter, adminAuth, async (req, res) => {
  const CourseMapping = (await import("../models/CourseMapping.js")).default;
  if (!req.params.id) return fail(res, 400, "id is required");
  const r = await CourseMapping.findByIdAndDelete(req.params.id);
  if (!r) return fail(res, 404, "Mapping not found");
  return ok(res, { deleted: true });
});
router.delete("/course-mappings", adminLimiter, adminAuth, async (req, res) => {
  const { subjectName, packageName, curriculum, grade } = req.body || {};
  if (!subjectName) return fail(res, 400, "subjectName is required");
  return ok(res, await removeMapping({ subjectName, packageName, curriculum, grade }));
});

// ---- Provisioning (idempotent; creates categories/courses in Moodle) -------
router.post("/provision", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await provisionStructure({ req })); }
  catch (err) { return fail(res, 502, "Provisioning failed.", { error: err.message }); }
});
router.get("/provision/status", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await provisionStatus()); }
  catch (err) { return fail(res, 500, "Provision status failed.", { error: err.message }); }
});

// ---- Sync every student (create/update account + align enrollments) --------
router.post("/sync-all-users", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await syncAllStudents({ limit: req.body?.limit || 500 })); }
  catch (err) { return fail(res, 502, "Bulk sync failed.", { error: err.message }); }
});

// ---- Sync every teacher (account + editing-teacher enrollments) -------------
router.post("/sync-all-teachers", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await syncAllTeachers({ limit: req.body?.limit || 500 })); }
  catch (err) { return fail(res, 502, "Bulk teacher sync failed.", { error: err.message }); }
});

// ---- Reconcile alias (canonical: /sync/reconcile above) --------------------
router.post("/reconcile", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await runReconciliation({ limit: req.body?.limit || 200 })); }
  catch (err) { return fail(res, 502, "Reconciliation failed.", { error: err.message }); }
});

// ---- Queue snapshot (pending / failed jobs) for the admin dashboard --------
router.get("/queue", adminLimiter, adminAuth, async (req, res) => ok(res, await queueSnapshot()));

// ---- Access preview: resolve a student's Moodle courses WITHOUT syncing ----
router.get("/access-preview/:id", adminLimiter, adminAuth, async (req, res) => {
  try {
    const { findStudent } = await import("../services/moodle/resolveStudent.js");
    const student = await findStudent(req.params.id);
    if (!student) return fail(res, 404, "Student not found");
    const access = await resolveStudentAccess(student);
    return ok(res, {
      student: {
        id: student._id, name: student.fullName, email: student.email,
        curriculum: access.curriculum, grade: access.grade,
        package: access.packageName, packageId: access.packageId,
        subjectSource: access.subjectSource, subjects: access.subjects,
      },
      courses: access.courses, warnings: access.warnings, ok: access.ok,
    });
  } catch (err) { return fail(res, 500, "Access preview failed.", { error: err.message }); }
});

// ---- Sync-status overview (dashboard stats: synced / no-courses / failed) ---
router.get("/sync-status", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await syncOverview()); }
  catch (err) { return fail(res, 500, "Sync status failed.", { error: err.message }); }
});

// ---- Admin warnings: students needing attention ----------------------------
router.get("/warnings", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, { warnings: await listWarnings({ limit: req.query.limit || 50 }) }); }
  catch (err) { return fail(res, 500, "Warnings lookup failed.", { error: err.message }); }
});

// ---- Retry failed / dead-letter sync jobs ----------------------------------
router.post("/retry-failed", adminLimiter, adminAuth, async (req, res) => {
  try { return ok(res, await retryFailedSyncs()); }
  catch (err) { return fail(res, 500, "Retry failed.", { error: err.message }); }
});
// ---- Force a class display-sync to Moodle (manual / remediation) ------------
// Backend is the single source of truth; this pushes the current ClassSession
// into a Moodle calendar event ("Join Virtual Class" link embedded), or removes
// it on cancellation.
router.post("/class-sync/:sessionId", adminLimiter, adminAuth, async (req, res) => {
  try {
    const { replayClassSync, syncClassSession } = await import("../services/moodle/index.js");
    const ClassSession = (await import("../models/ClassSession.js")).default;
    const session = await ClassSession.findById(req.params.sessionId)
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .populate("substituteTeacher", "fullName")
      .lean();
    if (!session) return fail(res, 404, "Class session not found");
    const action = (req.body?.action || (session.status === "cancelled" ? "CLASS_CANCELLED" : "CLASS_MEETING_READY"));
    const result = await (action === "CLASS_CANCELLED"
      ? syncClassSession(session, { action, sessionId: session._id })
      : syncClassSession(session, { action, sessionId: session._id }));
    return ok(res, { sessionId: session._id, action, synced: result.synced, live: result.live || false, outbox: result.outbox || false, moodleEventId: result.moodleEventId || null, details: result.payload || null });
  } catch (err) { return fail(res, 500, "Class sync failed.", { error: err.message }); }
});

// ===========================================================================
// Virtual Classroom launched FROM MOODLE
// ---------------------------------------------------------------------------
// These endpoints are called by the Moodle "studiesmasters_virtualclass" local
// plugin. Moodle cannot hold a JWT, so each request is an SSO-style signed
// payload (username|email|timestamp|nonce|course) verified against the shared
// secret. The signed username resolves to the Mongo principal, and the backend
// re-applies enrollment/assignment gates before returning any Meet link.
// All operations reuse the existing scheduling/attendance/notify services.
// ===========================================================================
const ssoClassLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

function readSignedQuery(req) {
  return {
    username: req.query.username,
    email: req.query.email,
    timestamp: req.query.timestamp,
    nonce: req.query.nonce,
    course: req.query.course,
    signature: req.query.signature,
    req,
  };
}

function verifyOrFail(res, verdict) {
  if (!verdict.ok) return res.status(401).json({ success: false, reason: verdict.reason });
  return null;
}

// List my virtual classes (student or teacher) from Moodle.
router.get("/vclass/sessions", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, listUserSessions } = await import("../services/moodle/classPortal.service.js");
    const verdict = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, verdict);
    if (denied) return;
    if (!verdict.principalId) return res.status(401).json({ success: false, reason: "no_principal" });
    const sessions = await listUserSessions({ role: verdict.role, principalId: verdict.principalId });
    return res.json({ success: true, role: verdict.role, sessions });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Join a class — the ONLY place a student gets the Meet link from Moodle.
router.post("/vclass/:sessionId/join", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, joinSession, leaveSession } = await import("../services/moodle/classPortal.service.js");
    const verdict = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, verdict);
    if (denied) return;
    const result = await joinSession({ role: verdict.role, principalId: verdict.principalId, sessionId: req.params.sessionId });
    if (result.error) return res.status(result.error.status).json(result.error);
    if (req.query.markLeave === "1") { // compatibility: join + immediate leave not used
      await leaveSession({ role: verdict.role, principalId: verdict.principalId, sessionId: req.params.sessionId });
    }
    return res.json(result);
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Leave a class from Moodle.
router.post("/vclass/:sessionId/leave", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, leaveSession } = await import("../services/moodle/classPortal.service.js");
    const verdict = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, verdict);
    if (denied) return;
    const result = await leaveSession({ role: verdict.role, principalId: verdict.principalId, sessionId: req.params.sessionId, joinedAt: req.query.joinedAt });
    if (result.error) return res.status(result.error.status).json(result.error);
    return res.json(result);
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Teacher: start a class from Moodle.
router.post("/vclass/:sessionId/start", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, startSession } = await import("../services/moodle/classPortal.service.js");
    const verdict = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, verdict);
    if (denied) return;
    const result = await startSession({ role: verdict.role, principalId: verdict.principalId, sessionId: req.params.sessionId });
    if (result.error) return res.status(result.error.status).json(result.error);
    return res.json(result);
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Teacher: end a class from Moodle.
router.post("/vclass/:sessionId/end", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, endSessionForMoodle } = await import("../services/moodle/classPortal.service.js");
    const verdict = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, verdict);
    if (denied) return;
    const result = await endSessionForMoodle({ role: verdict.role, principalId: verdict.principalId, sessionId: req.params.sessionId });
    if (result.error) return res.status(result.error.status).json(result.error);
    return res.json(result);
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});
// Unified dashboard (student & teacher) — Phase 7.
router.get("/vclass/dashboard", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, dashboardForUser } = await import("../services/moodle/classPortal.service.js");
    const v = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, v);
    if (denied) return;
    const dashboard = await dashboardForUser({ role: v.role, principalId: v.principalId });
    return res.json({ success: true, ...dashboard });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Attendance history (student = own; teacher = roster).
router.get("/vclass/attendance", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, attendanceHistoryForUser } = await import("../services/moodle/classPortal.service.js");
    const v = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, v);
    if (denied) return;
    const data = await attendanceHistoryForUser({ role: v.role, principalId: v.principalId });
    return ok(res, data);
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Recording library.
router.get("/vclass/recordings", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, recordingHistoryForUser } = await import("../services/moodle/classPortal.service.js");
    const v = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, v);
    if (denied) return;
    const rows = await recordingHistoryForUser({ role: v.role, principalId: v.principalId });
    return ok(res, { recordings: rows });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Recent notifications.
router.get("/vclass/notifications", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, notificationsForUser } = await import("../services/moodle/classPortal.service.js");
    const v = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, v);
    if (denied) return;
    const rows = await notificationsForUser({ role: v.role, principalId: v.principalId, limit: req.query.limit });
    return ok(res, { notifications: rows });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Teacher regenerates the meeting.
router.post("/vclass/:sessionId/regenerate", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest, regenerateSession } = await import("../services/moodle/classPortal.service.js");
    const v = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, v);
    if (denied) return;
    const result = await regenerateSession({ role: v.role, principalId: v.principalId, sessionId: req.params.sessionId });
    if (result.error) return res.status(result.error.status).json(result.error);
    return ok(res, result);
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// Download attendance CSV (teacher).
router.get("/vclass/attendance/:sessionId/export", ssoClassLimiter, async (req, res) => {
  try {
    const { verifyClassRequest } = await import("../services/moodle/classPortal.service.js");
    const v = await verifyClassRequest(readSignedQuery(req));
    const denied = verifyOrFail(res, v);
    if (denied) return;
    const ClassSession = (await import("../models/ClassSession.js")).default;
    const Student = (await import("../models/Student.js")).default;
    const session = await ClassSession.findById(req.params.sessionId)
      .populate("classGroup", "code subject grade curriculum")
      .lean();
    if (!session) return fail(res, 404, "Session not found");
    const isTeacher =
      String(session.teacher || "") === String(v.principalId) ||
      String(session.substituteTeacher || "") === String(v.principalId);
    if (!isTeacher) return fail(res, 403, "Only the assigned teacher can export this attendance");
    // Resolve student ids -> names (PII is intentional here: it's the class roster
    // the teacher legitimately needs; it is NOT exposed anywhere else).
    const ids = (session.attendance || []).map((a) => a.student);
    const students = await Student.find({ _id: { $in: ids } }).select("fullName email").lean();
    const byId = Object.fromEntries(students.map((s) => [String(s._id), s]));
    const rows = (session.attendance || []).map((a) => ({
      Name: byId[String(a.student)]?.fullName || "—",
      Email: byId[String(a.student)]?.email || "",
      JoinedAt: a.joinedAt ? new Date(a.joinedAt).toLocaleString() : "",
      LeftAt: a.leftAt ? new Date(a.leftAt).toLocaleString() : "",
      DurationMin: a.duration || 0,
    }));
    const { toCsv, csvBuffer } = await import("../services/qao/export.service.js");
    const headers = ["Name", "Email", "JoinedAt", "LeftAt", "DurationMin"];
    const csv = toCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-${session._id}.csv"`);
    return res.send(csvBuffer(csv));
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});
export default router;