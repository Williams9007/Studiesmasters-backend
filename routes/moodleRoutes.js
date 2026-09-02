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
  provisionStructure, provisionStatus, syncAllStudents, queueSnapshot,
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
    const Student = (await import("../models/Student.js")).default;
    const student = await Student.findById(req.params.id);
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

export default router;