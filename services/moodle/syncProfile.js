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
import { findStudent } from "./resolveStudent.js";
import { createUser } from "./createUser.js";
import { updateUser } from "./updateUser.js";
import { enrollUser } from "./enrollUser.js";
import { unenrollUser } from "./unenrollUser.js";
import { resolveStudentAccess } from "./accessResolver.js";
import { recordSyncStatus } from "./syncStatus.js";
import { getCourseIdsFor } from "./courseMapper.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";

// Match the access resolver's subject normalization (e.g. "Maths" -> "Mathematics").
const SUBJECT_ALIASES = { maths: "Mathematics", math: "Mathematics", " further mathematics": "Further Mathematics",
  "further math": "Further Mathematics", "ict": "ICT", "computing": "Computing" };
const normSubject = (s) => {
  const v = String(s || "").trim();
  if (!v) return v;
  const canonical = SUBJECT_ALIASES[v.toLowerCase()];
  return canonical || v;
};

function runId() {
  return `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function syncProfile({ id, role = "student", req = null, enroll = true }) {
  if (role === "teacher") {
    // Teachers get an account + enrollments derived from their TeacherAssignment
    // rows, enrolled with the Moodle "editing teacher" role (roleid 3).
    const Teacher = (await import("../../models/teacher.js")).default;
    const TeacherAssignment = (await import("../../models/TeacherAssignment.js")).default;
    const t = await Teacher.findById(id);
    if (!t) return { ok: false, error: "teacher not found" };
    // Teachers may store their name in `fullName` or the legacy `name` field.
    // A blank name means Moodle's dashboard greeting falls back to the
    // username (e.g. "Good morning, sm_t_..."), so always resolve a real name.
    const teacherName = String(t.fullName || t.name || "").trim();
    await createUser({ role: "teacher", id, email: t.email, fullName: teacherName, userId: t.userId, req });
    await updateUser({ role: "teacher", id, email: t.email, fullName: teacherName, req });

    if (!enroll) return { ok: true, role };

    // ---- Teacher course resolution ------------------------------------------
    // A teacher's courses come from their assignments. Two sources, merged:
    //   1. TeacherAssignment rows (curriculum/package/grade/subject), when used.
    //   2. The teacher's own subjectsTeaching + curriculum (subject across ALL
    //      grades — a teacher may teach the same subject in several grades).
    const CourseMapping = (await import("../../models/CourseMapping.js")).default;
    const Subject = (await import("../../models/Subject.js")).default;
    const assignments = await TeacherAssignment.find({ teacherId: id }).lean();

    const desired = [];
    const subjectNames = new Set();
    const curriculumSet = new Set();
    const addCourseIds = (ids) => { for (const cid of ids) if (!desired.includes(cid)) desired.push(cid); };

    // 1) From TeacherAssignment rows (per-grade, specific).
    for (const a of assignments) {
      const subject = normSubject(a.subject);
      subjectNames.add(subject);
      curriculumSet.add(a.curriculum);
      addCourseIds(await getCourseIdsFor({ subjects: [{ name: subject }], curriculum: a.curriculum, packageName: a.package, grade: a.grade }));
    }

    // 2) From the teacher's own subjectsTeaching — ONLY when no explicit
    //    TeacherAssignment rows exist (legacy fallback). When assignments
    //    exist they are authoritative: subject + class (grade), nothing more.
    const tPopulated = await Teacher.findById(id).populate("subjectsTeaching", "name grade package curriculum moodleCourseId").lean();
    const assignedCount = assignments.length || (tPopulated?.subjectsTeaching || []).length;
    if (!assignments.length) {
    const tCurriculum = normSubject(tPopulated?.curriculum);
    for (const subj of (tPopulated?.subjectsTeaching || [])) {
      const name = normSubject(subj?.name);
      if (!name) continue;
      subjectNames.add(name);
      curriculumSet.add(subj?.curriculum || tCurriculum);
      // The assigned Subject doc carries the teacher's assigned class (grade).
      // Resolve ONLY that subject+grade — never all grades of the subject.
      const ids = await getCourseIdsFor({
        subjects: [{ name, moodleCourseId: subj?.moodleCourseId }],
        curriculum: subj?.curriculum || tCurriculum || null,
        packageName: subj?.package || null,
        grade: subj?.grade || null,
      });
      // Fallback only when the specific subject+grade mapping is missing.
      if (!ids.length) {
        const q = tCurriculum ? { enabled: true, subjectName: name, curriculum: tCurriculum, grade: subj?.grade }
                              : { enabled: true, subjectName: name, grade: subj?.grade };
        const mappings = await CourseMapping.find(q).lean();
        for (const m of mappings) for (const t2 of (m.targets || [])) if (!ids.includes(t2.moodleCourseId)) ids.push(t2.moodleCourseId);
      }
      addCourseIds(ids);
    }
    }

    if (!desired.length) {
      const reason = assignedCount
        ? "NO_COURSES_FOUND: no CourseMapping rows match the teacher's subjects"
        : "NO_ASSIGNMENTS: teacher has no subject assignments yet";
      await audit({ action: "SYNC_WARNING", teacherRef: id, outcome: "failure", failure: reason,
        req, createdBy: "syncProfile" }).catch(() => {});
      return { ok: true, role, desired: [],
        warnings: [{ code: assignedCount ? "NO_COURSES_FOUND" : "NO_ASSIGNMENTS", message: reason }] };
    }

    const subjects = [...subjectNames].map((name) => ({ name }));
    const firstCurriculum = [...curriculumSet][0] || null;
    await enrollUser({ role: "teacher", id, subjects, curriculum: firstCurriculum,
      courseIds: desired, req });

    // Mirror: unenroll courses the teacher holds but which are no longer assigned.
    const link = await import("../../models/MoodleLink.js").then((m) =>
      m.default.findOne({ teacherRef: id }).lean());
    const held = link?.enrolledCourseIds || [];
    const obsolete = held.filter((c) => !desired.includes(c));
    if (obsolete.length) {
      const { unenrollUser } = await import("./unenrollUser.js");
      await unenrollUser({ role: "teacher", id, courseIds: obsolete, req });
      await audit({ action: "ENROLLMENT_REMOVED", teacherRef: id,
        detail: { courseIds: obsolete, reason: "teacher assignment removed/changed" } }).catch(() => {});
    }

    await audit({ action: "SYNC_COMPLETED", teacherRef: id, outcome: "success",
      detail: { coursesAssigned: desired.length, removed: obsolete.length } }).catch(() => {});
    return { ok: true, role, desired, removed: obsolete };
  }

  // Accept either the Mongo _id OR the public userId (e.g. "SM-ST-...").
  const student = await findStudent(id);
  if (!student) return { ok: false, error: "student not found" };

  // Normalize to the Mongo _id so downstream helpers (recordSyncStatus, audit,
  // MoodleLink lookups) always key by the real internal id, never a userId.
  id = student._id;

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