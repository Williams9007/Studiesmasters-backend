// services/moodle/syncProfile.js
//
// Full (re)sync of an authoritative StudiesMasters profile into Moodle: ensures
// the account exists (create), pushes mutable profile fields (update), then
// aligns enrollments to the course mapper's desired set (enroll/unenroll).
//
// This is the idempotent entry point used by:
//   - the admin "Sync now" endpoints
//   - the durable SyncJob worker (background sync)
//   - automatic change hooks when MOODLE_AUTO_SYNC=true
import Student from "../../models/Student.js";
import { createUser } from "./createUser.js";
import { updateUser } from "./updateUser.js";
import { enrollUser } from "./enrollUser.js";
import { unenrollUser } from "./unenrollUser.js";
import { resolveStudentAccess } from "./accessResolver.js";
import { recordSyncStatus } from "./syncStatus.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";

function runId() {
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function syncProfile({ id, role = "student", req = null, enroll = true }) {
  if (role === "teacher") {
    // Teachers only need an identity in Moodle (no subject enrollment carts).
    const Teacher = (await import("../../models/teacher.js")).default;
    const t = await Teacher.findById(id);
    if (!t) return { ok: false, error: "teacher not found" };
    await createUser({ role: "teacher", id, email: t.email, fullName: t.fullName, userId: t.userId, req });
    await updateUser({ role: "teacher", id, email: t.email, fullName: t.fullName, req });
    return { ok: true, role };
  }

  const student = await Student.findById(id);
  if (!student) return { ok: false, error: "student not found" };

  const rid = runId();
  await recordSyncStatus(id, { status: "SYNCING", runId: rid });
  await audit({ action: "SYNC_STARTED", studentRef: id, runId: rid, req, createdBy: "syncProfile" }).catch(() => {});

  try {
    // 1) Ensure the account exists in Moodle.
    await createUser({ role: "student", id: student._id, email: student.email, fullName: student.fullName, userId: student.userId, req });

    // 2) Push mutable profile fields (email/name etc.) — email is identity-safe.
    await updateUser({ role: "student", id: student._id, email: student.email, fullName: student.fullName, req });

    // 3) Reconcile enrollments (only when caller asks, default true).
    let enrollmentResult = null;
    if (enroll) enrollmentResult = await syncEnrollments({ student, req, runId: rid });

    if (!enrollmentResult?.blocked) {
      await recordSyncStatus(id, {
        status: enrollmentResult?.warnings?.length ? "WARNING" : "SYNCED",
        coursesAssigned: enrollmentResult?.desired?.length ?? 0,
        warnings: enrollmentResult?.warnings || [],
        runId: rid,
      });
    }
    await audit({ action: "SYNC_COMPLETED", studentRef: id, runId: rid, outcome: "success",
      detail: { coursesAssigned: enrollmentResult?.desired?.length ?? 0, warnings: enrollmentResult?.warnings?.length ?? 0 } }).catch(() => {});

    return { ok: true, studentId: student._id.toString(), ...(enrollmentResult || {}) };
  } catch (err) {
    logger.error(`Moodle syncProfile failed for student ${id}:`, err.message);
    await recordSyncStatus(id, { status: "FAILED", error: err.message, runId: rid });
    await audit({ action: "SYNC_FAILED", studentRef: id, runId: rid, outcome: "failure", failure: err.message, req }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

export async function syncEnrollments({ student, req = null, runId: rid = null }) {
  const id = student._id;

  // ---- Access Resolution Engine -------------------------------------------
  // Priority: selected subjects -> package mapping -> default system mapping.
  // Zero Course Protection: refuse to sync a student with zero resolvable
  // courses (status NO_COURSES_FOUND) — never leave an empty Moodle dashboard
  // and never unenroll what the student already has when resolution fails.
  const access = await resolveStudentAccess(student);
  const warnings = access.warnings || [];

  if (!access.ok) {
    await recordSyncStatus(id, { status: "NO_COURSES_FOUND", coursesAssigned: 0,
      warnings: warnings.length ? warnings : [{ code: "NO_COURSES_FOUND", message: "No matching Moodle courses found. Review CourseMapping." }],
      runId: rid });
    await audit({ action: "SYNC_FAILED", studentRef: id, runId: rid, outcome: "failure",
      failure: "NO_COURSES_FOUND: no matching Moodle courses for this student's curriculum/grade/subjects",
      detail: { access: { subjects: access.subjects, curriculum: access.curriculum, grade: access.grade, packageId: access.packageId } } }).catch(() => {});
    return { ok: false, blocked: true, reason: "NO_COURSES_FOUND", desired: [], removed: [], warnings };
  }

  const desired = access.courses.map((c) => c.courseId);
  const subjects = access.subjects.map((name) => ({ name }));

  // Enroll into desired courses not yet held (idempotent).
  await enrollUser({
    role: "student", id, subjects, curriculum: access.curriculum,
    packageName: access.packageName, grade: access.grade, courseIds: desired, req,
  });

  // True mirror: unenroll courses the user holds but which are no longer
  // desired (package changed, curriculum/grade changed, subject removed).
  const link = await import("../../models/MoodleLink.js").then((m) =>
    m.default.findOne({ studentRef: id }).lean());
  const held = link?.enrolledCourseIds || [];
  const obsolete = held.filter((c) => !desired.includes(c));
  if (obsolete.length) {
    await unenrollUser({ role: "student", id, courseIds: obsolete, req });
    await audit({ action: "ENROLLMENT_REMOVED", studentRef: id, runId: rid,
      detail: { courseIds: obsolete, reason: "no longer desired after access resolution" } }).catch(() => {});
  }

  return { ok: true, desired, removed: obsolete, warnings, access: { packageId: access.packageId, subjectSource: access.subjectSource } };
}

export default syncProfile;