// services/moodle/syncTimetable.js
//
// Backend-authoritative TIMETABLE sync into Moodle using STOCK web services
// (no custom plugin):
//
//   1. syncTimetableForStudent()  - pushes the student's week of ClassSessions
//      into Moodle as USER calendar events, so the student sees their personal
//      timetable inside Moodle's Calendar + Upcoming-events block. Each event
//      description carries the Google Meet "Join Virtual Class" link, making
//      MOODLE the place students access their live classes.
//   2. syncLiveClasses()          - bulk re-push of upcoming/live classes as
//      COURSE events (via the existing syncClassSession), so Moodle always has
//      a current view of what is live/upcoming even if a push was missed.
//
// Guarantees (mirrors syncClass.js):
//   - MongoDB stays the single source of truth; this is display-only.
//   - Idempotent: existing user events are matched by their "[SM] <sessionId>"
//     name and updated in place — never duplicated.
//   - MOODLE_DRY_RUN (default) simulates the push without touching Moodle.
//   - Never throws to the caller; every failure is audited and summarised.
import Student from "../../models/Student.js";
import ClassGroup from "../../models/ClassGroup.js";
import ClassSession from "../../models/ClassSession.js";
import "../../models/teacher.js"; // register the Teacher model (refs in ClassGroup/ClassSession)
import { config } from "./config.js";
import { callWs } from "./client.js";
import { moodleUsernameFor } from "./store.js";
import { syncProfile } from "./syncProfile.js";
import { syncClassSession, CLASS_SYNC_ACTIONS } from "./syncClass.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";

const EVENT_NAME_PREFIX = "[SM]";

/** Default window: Monday of the current week -> +14 days. */
function defaultRange() {
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - ((now.getDay() + 6) % 7));
  const to = new Date(from);
  to.setDate(to.getDate() + 14);
  return { from, to };
}

/** Epoch start + duration in minutes for a session (or null if un-timed). */
function sessionTimes(session) {
  const [h, m] = String(session.startTime || "0:0").split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  const start = new Date(new Date(session.date).setHours(h || 0, m || 0, 0, 0));
  const [eh, em] = String(session.endTime || "").split(":").map(Number);
  let duration = 3600;
  if (Number.isFinite(eh)) duration = Math.max(300, eh * 3600 + em * 60 - (h * 3600 + m * 60));
  return { timestart: Math.floor(start.getTime() / 1000), timeduration: Math.floor(duration / 60) };
}

function eventBody(session) {
  const t = sessionTimes(session);
  if (!t) return null;
  const groupId = String(session._id || session.sessionId || "");
  const teacher = session.teacher?.fullName || session.teacher?.name || "Teacher TBA";
  const description = [
    `<p><b>${session.classGroup?.subject || session.subject || "Class"}</b> · ${session.classGroup?.grade || session.grade || ""}</p>`,
    `<p>${new Date(session.date).toDateString()} · ${session.startTime}–${session.endTime}</p>`,
    `<p>Tutor: ${teacher}</p>`,
    session.meetingLink
      ? `<p><a href="${session.meetingLink}">Join Virtual Class</a></p>`
      : `<p>The meeting link will appear here once the tutor starts the class.</p>`,
  ].join("");
  return {
    name: `${EVENT_NAME_PREFIX} ${groupId} ${session.classGroup?.subject || session.subject || "Class"}`.slice(0, 180),
    description,
    timestart: t.timestart,
    timeduration: t.timeduration,
    format: 1, // HTML description
    visible: 1,
  };
}

/**
 * Resolve the student's Moodle user id (creating the account on first use via
 * syncProfile). Returns { moodleUserId, moodleUsername } or null.
 */
async function resolveMoodleUser(principal, role) {
  const moodleUsername = moodleUsernameFor({ role, id: principal._id });
  const find = async () => {
    try {
      const r = await callWs("core_user_get_users_by_field", { field: "username", "values[0]": moodleUsername });
      const u = Array.isArray(r) ? r[0] : r?.users?.[0];
      return Number(u?.id) || null;
    } catch { return null; }
  };
  let moodleUserId = await find();
  if (!moodleUserId) {
    try { await syncProfile({ id: principal._id, role, enroll: true }); } catch { /* retried below */ }
    moodleUserId = await find();
  }
  return moodleUserId ? { moodleUserId, moodleUsername } : null;
}

/** Existing user-event ids keyed by the embedded session id. */
async function existingUserEventIds() {
  try {
    const events = await callWs("core_calendar_get_calendar_events", { userevents: 1, siteevents: 0 });
    const map = new Map();
    for (const ev of events?.events || []) {
      if (typeof ev?.name === "string" && ev.name.startsWith(EVENT_NAME_PREFIX)) {
        const sessionId = ev.name.split(" ")[1]; // "[SM] <sessionId> <subject>"
        if (sessionId) map.set(sessionId, Number(ev.id));
      }
    }
    return map;
  } catch { return new Map(); } // listing failure must not block creation
}

/**
 * Sync one student's timetable (their class groups' sessions) into Moodle as
 * user calendar events. Never throws.
 */
export async function syncTimetableForStudent({ studentId, from = null, to = null, req = null } = {}) {
  try {
    if (!config.enabled) return { synced: false, reason: "moodle-disabled" };

    const student = await Student.findById(studentId).lean();
    if (!student) return { synced: false, reason: "student-not-found" };

    const groups = await ClassGroup.find({ students: student._id }).select("_id").lean();
    if (!groups.length) return { synced: false, reason: "no-class-groups" };

    const range = { from: from ? new Date(from) : defaultRange().from, to: to ? new Date(to) : defaultRange().to };
    const sessions = await ClassSession.find({
      classGroup: { $in: groups.map((g) => g._id) },
      date: { $gte: range.from, $lt: range.to },
      status: { $in: ["scheduled", "live"] },
    })
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName name")
      .sort({ date: 1, startTime: 1 })
      .lean();

    if (!sessions.length) return { synced: false, reason: "no-sessions-in-range", total: 0 };

    // Dry-run: simulate a successful push without touching Moodle.
    if (config.dryRun) {
      await audit({ action: "TIMETABLE_SYNC", studentRef: student._id, role: "student", outcome: "success", detail: { dryRun: true, total: sessions.length }, req }).catch(() => {});
      return { synced: true, dryRun: true, created: sessions.length, updated: 0, failed: 0, total: sessions.length };
    }

    const user = await resolveMoodleUser(student, "student");
    if (!user) {
      await audit({ action: "TIMETABLE_SYNC", studentRef: student._id, role: "student", outcome: "failure", failure: { message: "Moodle user not found/provisionable" }, req }).catch(() => {});
      return { synced: false, reason: "moodle-user-not-found", total: sessions.length };
    }

    const existing = await existingUserEventIds();
    let created = 0;
    let updated = 0;
    let failed = 0;
    const events = [];

    for (const session of sessions) {
      const body = eventBody(session);
      const sid = String(session._id);
      if (!body) { failed += 1; events.push({ sessionId: sid, error: "un-timed session" }); continue; }
      try {
        const existingId = existing.get(sid);
        if (existingId) {
          await callWs("core_calendar_delete_calendar_events", { "events[0][eventid]": existingId, "events[0][repeat]": 0 });
        }
        const res = await callWs("core_calendar_create_calendar_events", {
          "events[0][userid]": user.moodleUserId,
          "events[0][name]": body.name,
          "events[0][description]": body.description,
          "events[0][format]": body.format,
          "events[0][timestart]": body.timestart,
          "events[0][timeduration]": body.timeduration,
          "events[0][visible]": body.visible,
        });
        const createdEv = Array.isArray(res?.events) ? res.events[0] : res?.event || null;
        const moodleEventId = Number(createdEv?.id || createdEv?.eventid || 0) || null;
        created += 1;
        events.push({ sessionId: sid, moodleEventId, action: existingId ? "recreated" : "created" });
      } catch (err) {
        failed += 1;
        events.push({ sessionId: sid, error: String(err?.message || err).slice(0, 200) });
      }
    }

    await audit({
      action: "TIMETABLE_SYNC", studentRef: student._id, role: "student",
      moodleUserId: user.moodleUserId, moodleUsername: user.moodleUsername,
      outcome: failed ? (created + updated ? "success" : "failure") : "success",
      failure: failed ? { message: `${failed} session(s) failed` } : null,
      detail: { from: range.from, to: range.to, created, updated, failed, total: sessions.length, events },
      req,
    }).catch(() => {});
    logger.info(`[MOODLE] timetable sync for student ${student._id}: created=${created} updated=${updated} failed=${failed}`);

    return { synced: created + updated > 0 || failed === 0, created, updated, failed, total: sessions.length, events };
  } catch (err) {
    logger.warn(`[MOODLE] timetable sync failed: ${err?.message || err}`);
    return { synced: false, reason: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * Bulk re-push of upcoming/live classes into Moodle (course/site events via
 * the existing syncClass pipeline). Never throws.
 */
export async function syncLiveClasses({ from = null, to = null } = {}) {
  const range = {
    from: from ? new Date(from) : new Date(Date.now() - 60 * 60 * 1000), // include just-started classes
    to: to ? new Date(to) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  };
  const sessions = await ClassSession.find({
    date: { $gte: range.from, $lt: range.to },
    status: { $in: ["scheduled", "live"] },
  })
    .populate("classGroup", "code subject grade curriculum")
    .populate("teacher", "fullName name")
    .populate("substituteTeacher", "fullName")
    .sort({ date: 1, startTime: 1 })
    .lean();

  let synced = 0;
  let failed = 0;
  let queued = 0;
  for (const session of sessions) {
    try {
      const res = await syncClassSession(session, { action: CLASS_SYNC_ACTIONS.UPDATED, sessionId: String(session._id) });
      if (res?.synced) synced += 1;
      else if (res?.queued) queued += 1;
      else failed += 1;
    } catch { failed += 1; }
  }
  return { total: sessions.length, synced, failed, queued, from: range.from, to: range.to };
}

/**
 * Sync one teacher's timetable (their sessions as main teacher OR substitute)
 * into Moodle as user calendar events. Teachers manage the live class from
 * Moodle; every action there still records back into MongoDB. Never throws.
 */
export async function syncTimetableForTeacher({ teacherId, from = null, to = null, req = null } = {}) {
  try {
    if (!config.enabled) return { synced: false, reason: "moodle-disabled" };

    const Teacher = (await import("../../models/teacher.js")).default;
    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) return { synced: false, reason: "teacher-not-found" };

    const range = { from: from ? new Date(from) : defaultRange().from, to: to ? new Date(to) : defaultRange().to };
    const sessions = await ClassSession.find({
      $or: [{ teacher: teacher._id }, { substituteTeacher: teacher._id }],
      date: { $gte: range.from, $lt: range.to },
      status: { $in: ["scheduled", "live"] },
    })
      .populate("classGroup", "code subject grade curriculum")
      .sort({ date: 1, startTime: 1 })
      .lean();

    if (!sessions.length) return { synced: false, reason: "no-sessions-in-range", total: 0 };

    if (config.dryRun) {
      await audit({ action: "TIMETABLE_SYNC", teacherRef: teacher._id, role: "teacher", outcome: "success", detail: { dryRun: true, total: sessions.length }, req }).catch(() => {});
      return { synced: true, dryRun: true, created: sessions.length, updated: 0, failed: 0, total: sessions.length };
    }

    const user = await resolveMoodleUser(teacher, "teacher");
    if (!user) {
      await audit({ action: "TIMETABLE_SYNC", teacherRef: teacher._id, role: "teacher", outcome: "failure", failure: { message: "Moodle user not found/provisionable" }, req }).catch(() => {});
      return { synced: false, reason: "moodle-user-not-found", total: sessions.length };
    }

    const existing = await existingUserEventIds();
    let created = 0;
    let updated = 0;
    let failed = 0;
    const events = [];

    for (const session of sessions) {
      const body = eventBody(session);
      const sid = String(session._id);
      if (!body) { failed += 1; events.push({ sessionId: sid, error: "un-timed session" }); continue; }
      try {
        const existingId = existing.get(sid);
        if (existingId) {
          await callWs("core_calendar_delete_calendar_events", { "events[0][eventid]": existingId, "events[0][repeat]": 0 });
        }
        const res = await callWs("core_calendar_create_calendar_events", {
          "events[0][userid]": user.moodleUserId,
          "events[0][name]": body.name,
          "events[0][description]": body.description,
          "events[0][format]": body.format,
          "events[0][timestart]": body.timestart,
          "events[0][timeduration]": body.timeduration,
          "events[0][visible]": body.visible,
        });
        const createdEv = Array.isArray(res?.events) ? res.events[0] : res?.event || null;
        const moodleEventId = Number(createdEv?.id || createdEv?.eventid || 0) || null;
        created += 1;
        events.push({ sessionId: sid, moodleEventId, action: existingId ? "recreated" : "created" });
      } catch (err) {
        failed += 1;
        events.push({ sessionId: sid, error: String(err?.message || err).slice(0, 200) });
      }
    }

    // Also make sure every class group this teacher runs is enrolled in Moodle
    // (teacher as editing teacher + all students), so calendar events and the
    // virtual classroom resolve to the right course members.
    let groupsSynced = 0;
    try {
      const taught = await ClassGroup.find({ $or: [{ teacher: teacher._id }] }).select("_id").lean();
      for (const g of taught) {
        const r = await syncClassGroupEnrollment({ classGroupId: g._id, req });
        if (r.synced) groupsSynced += 1;
      }
    } catch { /* non-fatal */ }

    await audit({
      action: "TIMETABLE_SYNC", teacherRef: teacher._id, role: "teacher",
      moodleUserId: user.moodleUserId, moodleUsername: user.moodleUsername,
      outcome: failed ? (created + updated ? "success" : "failure") : "success",
      failure: failed ? { message: `${failed} session(s) failed` } : null,
      detail: { from: range.from, to: range.to, created, updated, failed, total: sessions.length, groupsSynced, events },
      req,
    }).catch(() => {});

    return { synced: created + updated > 0 || failed === 0, created, updated, failed, total: sessions.length, groupsSynced, events };
  } catch (err) {
    logger.warn(`[MOODLE] teacher timetable sync failed: ${err?.message || err}`);
    return { synced: false, reason: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * Sync a class group's Moodle enrolment: enrolls the assigned teacher (roleid
 * 3 = editing teacher) and every enrolled student (roleid 5 = student) into
 * the Moodle courses mapped for the group's subject/curriculum/grade — so the
 * group's classes and calendar events show up for exactly the right people.
 * Best-effort; never throws.
 */
export async function syncClassGroupEnrollment({ classGroupId, req = null } = {}) {
  try {
    if (!config.enabled) return { synced: false, reason: "moodle-disabled" };
    const group = await ClassGroup.findById(classGroupId)
      .populate("teacher", "fullName email")
      .populate("students", "fullName email")
      .lean();
    if (!group) return { synced: false, reason: "group-not-found" };

    const { enrollUser } = await import("./enrollUser.js");
    // getCourseIdsFor() expects subject OBJECTS ({ name }), not bare strings.
    const base = { curriculum: group.curriculum, grade: group.grade, subjects: [{ name: group.subject }] };
    const results = { teacher: null, students: [], failed: 0, coursesTargeted: [] };

    // Provision any principal that does not have a Moodle account yet —
    // enrollUser silently skips "not_provisioned" users, so we must create
    // the accounts (+ enrolments) before enrolling into the mapped courses.
    const provision = async (role, principal) => {
      const MoodleLink = (await import("../../models/MoodleLink.js")).default;
      const refKey = role === "teacher" ? { teacherRef: principal._id } : { studentRef: principal._id };
      const link = await MoodleLink.findOne(refKey).lean();
      if (!link?.moodleUserId) {
        await syncProfile({ id: principal._id, role, enroll: true, req });
      }
    };

    if (group.teacher?._id) {
      try {
        await provision("teacher", group.teacher);
        results.teacher = await enrollUser({ role: "teacher", id: group.teacher._id, ...base, roleid: 3, req });
      } catch (err) {
        // Moodle tokens without role-assign capability reject roleid 3
        // ("Access control exception"). Fall back to roleid 5 so the teacher
        // still gets course access; a Moodle admin can promote them later.
        const msg = String(err?.message || err);
        if (/access control/i.test(msg)) {
          try {
            results.teacher = await enrollUser({ role: "teacher", id: group.teacher._id, ...base, roleid: 5, req });
            results.teacherRoleFallback = "editing-teacher role was rejected by Moodle (token capability); teacher enrolled with the student role instead — promote in Moodle if needed.";
          } catch (err2) {
            results.teacher = { error: String(err2?.message || err2).slice(0, 160) };
            results.failed += 1;
          }
        } else {
          results.teacher = { error: msg.slice(0, 160) };
          results.failed += 1;
        }
      }
    }
    for (const st of group.students || []) {
      try {
        await provision("student", st);
        const r = await enrollUser({ role: "student", id: st._id, ...base, req });
        results.students.push({ studentId: st._id, name: st.fullName, enrolled: r.enrolled || [], alreadyEnrolled: r.alreadyEnrolled || [], skipped: r.skipped ? r.reason : undefined });
        if (r.enrolled?.length) results.coursesTargeted.push(...r.enrolled);
      } catch (err) {
        results.students.push({ studentId: st._id, name: st.fullName, error: String(err?.message || err).slice(0, 160) });
        results.failed += 1;
      }
    }

    await audit({
      action: "GROUP_ENROLL_SYNC", role: "teacher",
      outcome: results.failed ? "failure" : "success",
      failure: results.failed ? { message: `${results.failed} enrolment(s) failed` } : null,
      detail: { classGroupId, groupCode: group.code, teacher: group.teacher?._id || null, students: (group.students || []).length },
      req,
    }).catch(() => {});
    return { synced: true, groupCode: group.code, ...results };
  } catch (err) {
    return { synced: false, reason: String(err?.message || err).slice(0, 200) };
  }
}

export default { syncTimetableForStudent, syncTimetableForTeacher, syncClassGroupEnrollment, syncLiveClasses };
