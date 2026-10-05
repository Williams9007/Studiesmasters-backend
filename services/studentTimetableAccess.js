// services/studentTimetableAccess.js
//
// SINGLE SOURCE OF TRUTH for "which timetable may this student see?".
//
// The StudiesMasters backend is the only authority for timetable visibility.
// Moodle is a pure presentation layer: it never queries ClassGroup/ClassSession
// itself and never widens a result set — it only renders what these helpers
// returned. Every surface that can expose a class to a student goes through
// here, so the rule cannot drift between the calendar, the dashboard widget,
// "Upcoming classes", the Live Classes page, notifications and the Google Meet
// link resolution.
//
// The rule (all gates must pass, and NONE of them can be satisfied by matching
// on grade/curriculum/subject alone):
//
//   1. studentId     - resolved from MongoDB, never from a client-supplied body
//   2. class group   - the student must be in ClassGroup.students
//   3. enrolment     - the group must not be "closed" (active/full only)
//   4. curriculum    - the group's curriculum must match the student's
//   5. grade         - the group's grade must match the student's (when the
//                      student has a recorded grade)
//
// Consequence — the scenario from the brief:
//   Class Group A = "JHS 1 Mathematics Class 1", Monday 16:00
//   Class Group B = "JHS 1 Mathematics Class 2", Monday 18:00
//   Alice -> A, Bob -> B.  Identical grade/curriculum/subject does NOT widen
//   the result: Alice can never see Class 2, Bob can never see Class 1.
import mongoose from "mongoose";
import Student from "../models/Student.js";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";

// A closed group is no longer an active enrolment: its students keep the
// historical record but must not see the group's schedule or Meet links.
const ENROLLED_GROUP_STATUSES = ["active", "full"];

/** Case/whitespace tolerant comparison for curriculum + grade labels. */
function sameLabel(a, b) {
  const x = String(a ?? "").trim().toLowerCase();
  const y = String(b ?? "").trim().toLowerCase();
  return Boolean(x) && x === y;
}

/**
 * Normalise anything that can identify a Mongo document (an ObjectId instance,
 * a 24-char hex string, or an object exposing toHexString()) into a validated
 * lowercase hex string; null for anything else. This is the guard that keeps
 * the `$in: [...]` scopes below from ever becoming `$in: [null, ""]`.
 *
 * ObjectId instances MUST be accepted: every authenticated caller hands us one
 * (req.user._id from studentAuth, and the `_id`s of the lean docs returned by
 * this module). A string-only guard looked correct in a route that passes
 * req.params, while silently emptying the timetable for every real caller.
 */
export function toIdString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === "object" && typeof value.toHexString === "function") return value.toHexString();
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  const normalized = String(new mongoose.Types.ObjectId(raw));
  return normalized === raw.toLowerCase() ? normalized : null;
}

/** A valid, non-empty Mongo ObjectId (guards $in: [null, ""]). */
function isObjectId(value) {
  return Boolean(toIdString(value));
}

/**
 * The permission gates for ONE class group, as pure data (no DB) so the rule can
 * be unit-tested and reused by any surface:
 *   gate 2  the student is a member of the group
 *   gate 3  the enrolment is still active ("closed" groups fall away)
 *   gate 4  the group's curriculum matches the student's registration
 *   gate 5  the group's grade matches the student's (when recorded)
 */
export function passesAccessGates({ student, group }) {
  if (!student || !group) return false;
  const studentId = toIdString(student._id || student.id);
  if (!studentId) return false;

  // Gate 2: membership. `students` may be ids or populated docs.
  const members = Array.isArray(group.students) ? group.students : [];
  if (!members.some((m) => toIdString(m?._id || m) === studentId)) return false;

  // Gate 3: active enrolment only.
  if (!ENROLLED_GROUP_STATUSES.includes(String(group.status || "active"))) return false;
  // Gate 4: curriculum must match the student's registration.
  if (student.curriculum && !sameLabel(group.curriculum, student.curriculum)) return false;
  // Gate 5: grade must match too (skipped when the student has no recorded
  // grade — the class-group membership is then the only grade authority).
  if (student.grade && !sameLabel(group.grade, student.grade)) return false;
  return true;
}

/**
 * Resolve the student document for an authenticated principal id.
 * Returns null when the id is malformed or no student matches.
 */
export async function loadStudent(studentId) {
  const id = toIdString(studentId);
  if (!id) return null;
  return Student.findById(id).select("_id fullName userId curriculum grade").lean();
}

/**
 * The student's ASSIGNED class groups — the authoritative membership set.
 *
 * Returns only groups that pass EVERY gate (membership, active enrolment,
 * curriculum, grade). An empty array is a valid, successful answer: a student
 * with no active class group has no timetable, and the caller must return an
 * empty event list rather than falling back to a broader query.
 */
export async function getAssignedClassGroups(studentId) {
  const student = await loadStudent(studentId);
  if (!student) return [];

  // `students` is selected because membership is gate 2 of passesAccessGates();
  // it is stripped again below so no surface ever serialises a class roster.
  const groups = await ClassGroup.find({ students: student._id })
    .select("_id code subject grade curriculum status students")
    .lean();

  return (groups || [])
    .filter((g) => passesAccessGates({ student, group: g }))
    .map(({ students: _roster, ...group }) => group);
}

/** Convenience: the assigned class-group ids only. */
export async function getAssignedClassGroupIds(studentId) {
  const groups = await getAssignedClassGroups(studentId);
  return groups.map((g) => g._id);
}

/**
 * Build the Mongo filter that restricts ClassSession to a student's assigned
 * groups. Returns null when the student has no assigned group, so callers can
 * short-circuit to an empty list WITHOUT ever running an unscoped query.
 */
export async function studentSessionScope(studentId) {
  const groupIds = await getAssignedClassGroupIds(studentId);
  if (!groupIds.length) return null;
  return { classGroup: { $in: groupIds } };
}

/**
 * Load a student's timetable sessions through the enforced scope.
 *
 * @param {string} studentId
 * @param {object} opts
 * @param {Date|null} opts.from  range start (inclusive)
 * @param {Date|null} opts.to    range end (exclusive)
 * @param {string[]} [opts.statuses] allowed session statuses
 * @param {number} [opts.limit]
 * @returns {Promise<{ groups: object[], sessions: object[], assignedGroupIds: string[] }>}
 *          `sessions` is ALWAYS [] when the student has no active class group.
 */
export async function loadStudentTimetable(studentId, { from = null, to = null, statuses = null, limit = 0 } = {}) {
  const groups = await getAssignedClassGroups(studentId);
  const assignedGroupIds = groups.map((g) => g._id);
  if (!assignedGroupIds.length) return { groups, sessions: [], assignedGroupIds };

  const query = { classGroup: { $in: assignedGroupIds } };
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = from;
    if (to) query.date.$lt = to;
  }
  if (Array.isArray(statuses) && statuses.length) query.status = { $in: statuses };

  let cursor = ClassSession.find(query)
    .populate("classGroup", "code subject grade curriculum status")
    .populate("teacher", "fullName name")
    .populate("substituteTeacher", "fullName name")
    .sort({ date: 1, startTime: 1 });
  if (limit > 0) cursor = cursor.limit(limit);

  const rows = await cursor.lean();

  // Defence in depth: even if a populate/populate mismatch ever produced a row
  // whose classGroup is missing, closed, or outside the assigned set, it is
  // dropped here rather than handed to Moodle.
  // Defence in depth, shared with every other surface: any row outside the
  // assigned set - or whose class group cannot be resolved at all - is dropped
  // rather than handed to Moodle or the app.
  const sessions = filterSessionsForAssignedGroups(rows, assignedGroupIds).filter((s) => {
    if (s.classGroup && typeof s.classGroup === "object") {
      return ENROLLED_GROUP_STATUSES.includes(String(s.classGroup.status || "active"));
    }
    return true;
  });

  return { groups, sessions, assignedGroupIds };
}

/** The classGroupId behind a session, whether the ref is populated or bare. */
export function resolveClassGroupId(session) {
  const raw = session?.classGroup ?? session?.classGroupId ?? null;
  if (raw && typeof raw === "object") return toIdString(raw._id);
  return toIdString(raw);
}

/**
 * Defence in depth: re-check rows against the assigned set AFTER the query, so a
 * populate/mismatch bug can never hand another class group's class to a surface.
 * A row whose class group cannot be resolved is DROPPED, never rendered.
 */
export function filterSessionsForAssignedGroups(sessions, assignedGroupIds) {
  const allowed = new Set((assignedGroupIds || []).map((id) => toIdString(id)).filter(Boolean));
  if (!allowed.size) return [];
  return (sessions || []).filter((s) => allowed.has(resolveClassGroupId(s)));
}

/** The classGroupId behind a notification, or null for a school-wide notice. */
export function resolveNotificationClassGroupId(notification) {
  const raw = notification?.classGroupId || notification?.classGroup || null;
  return toIdString(raw?._id || raw);
}

/**
 * Notification gate: a school-wide notice (no class group) is always allowed; a
 * class-group notice is allowed only while that group is still an active
 * assignment. This is what stops "your class is live now" reaching a student who
 * is not in that class.
 */
export function isNotificationVisibleToStudent(notification, assignedGroupIds) {
  const ref = resolveNotificationClassGroupId(notification);
  if (!ref) return true;
  const allowed = new Set((assignedGroupIds || []).map((id) => toIdString(id)).filter(Boolean));
  return allowed.has(ref);
}

/**
 * Permission check for a single session (used before any Meet link is handed
 * out). Returns the session when the student is entitled to it, else null.
 */
export async function assertSessionBelongsToStudent({ studentId, sessionId }) {
  const assigned = new Set((await getAssignedClassGroupIds(studentId)).map(String));
  if (!assigned.size || !isObjectId(String(sessionId || ""))) return null;
  const session = await ClassSession.findById(sessionId)
    .populate("classGroup", "students code subject grade curriculum status")
    .lean();
  if (!session) return null;
  const gid = session.classGroup && typeof session.classGroup === "object" ? session.classGroup._id : session.classGroup;
  if (!assigned.has(String(gid))) return null;
  const group = session.classGroup && typeof session.classGroup === "object" ? session.classGroup : null;
  if (group && !ENROLLED_GROUP_STATUSES.includes(String(group.status || "active"))) return null;
  return session;
}

export default {
  loadStudent,
  getAssignedClassGroups,
  getAssignedClassGroupIds,
  studentSessionScope,
  loadStudentTimetable,
  assertSessionBelongsToStudent,
  ENROLLED_GROUP_STATUSES,
  // Pure helpers (also available as named exports) so any surface — and the
  // tests — can re-check rows/notifications without hitting the database.
  passesAccessGates,
  resolveClassGroupId,
  filterSessionsForAssignedGroups,
  resolveNotificationClassGroupId,
  isNotificationVisibleToStudent,
  toIdString,
};
