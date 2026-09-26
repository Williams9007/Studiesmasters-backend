// services/timetable.service.js
//
// Recurring weekly-timetable feature for StudiesMasters.
//
// The Tutor Manager (QAO) / admin feeds in a class's weekly timetable MANUALLY
// (a set of recurring day/time slots per class group, with a teacher assigned)
// and then asks the system to "schedule it" for the term:
//
//   saveWeeklySlots()        - store { day, startTime, endTime }[] on a class
//   generateRangeSessions()  - expand those weekly slots into concrete
//                              ClassSession records across a chosen date range.
//                              Each session reuses scheduling.createSession() so
//                              it automatically gets a Google Calendar event +
//                              Google Meet link (or a mock meet in dev), is
//                              conflict/availability checked, and is grouped
//                              under its class in listWeeklyTimetable().
//
// It deliberately leverages the existing ClassGroup + ClassSession + scheduling
// infrastructure so student/teacher join, attendance and live-class flows keep
// working unchanged.
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import { sanitizeClassGroup } from "./qao/sanitize.js";
import { normalizeWeeklySlots } from "./qao/classGroup.service.js";
import { createSession } from "./qao/scheduling.service.js";
import { notifyTeacher, notifyStudents, notifyAllQaos } from "./qao/notification.service.js";
import { emitToStudents, emitToTeacher } from "./qao/notify.js";
import { sendTimetableEmail } from "../utils/sendTimetableEmail.js";
// The push controller is imported dynamically inside publishTimetable() below.
// The project is referenced with inconsistent casing by the TypeScript compiler.
// @ts-ignore TS1149: preserve the runtime import path while suppressing the casing diagnostic.

// Map a weekday name to JS Date#getDay() (0 = Sunday ... 6 = Saturday).
const DAY_TO_JS = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

// Parallelism limits: Google Calendar / Meet creation and outbound SMTP both
// throttle under bursts, so batch work runs with bounded concurrency instead
// of an unbounded Promise.all over the whole term.
const CREATE_CONCURRENCY = 4;
const EMAIL_CONCURRENCY = 5;

/** Run `fn` over `items` with at most `limit` calls in flight; preserves order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One human-readable summary line, reused for the durable notification + push body. */
function summaryLine(scope, count, rangeStart, rangeEnd) {
  return `${scope}: ${count} class${count === 1 ? "" : "es"} from ${rangeStart} to ${rangeEnd}.`;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map((n) => {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  });
  return (h || 0) * 60 + (m || 0);
}

function toDateOnly(value) {
  const d = new Date(value);
  d.setHours(12, 0, 0, 0); // noon avoids DST / TZ boundary issues while iterating
  return d;
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Weekly slots for a class: prefer the rich weeklySlots, fall back to legacy schedule. */
export function effectiveSlots(group) {
  if (group.weeklySlots && group.weeklySlots.length) return group.weeklySlots;
  if (group.schedule && group.schedule.day && group.schedule.startTime) {
    return [group.schedule];
  }
  return [];
}

function safeSession(s) {
  const sg = s.classGroup;
  return {
    _id: s._id,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    durationMinutes: s.durationMinutes,
    status: s.status,
    meetingLink: s.meetingLink,
    meetingStatus: s.meetingStatus,
    meetingCode: s.meetingCode,
    classGroup: sg ? { _id: sg._id, code: sg.code, subject: sg.subject, grade: sg.grade } : null,
    teacher: s.teacher
      ? { _id: s.teacher._id, fullName: s.teacher.fullName || s.teacher.name, email: s.teacher.email }
      : null,
    substituteTeacher: s.substituteTeacher
      ? { _id: s.substituteTeacher._id, fullName: s.substituteTeacher.fullName || s.substituteTeacher.name }
      : null,
  };
}

/**
 * The grouped weekly timetable.
 * Returns one entry per class: the class (QAO-safe) plus its generated
 * (upcoming) sessions grouped underneath. The Google Calendar / Meet link for
 * each session is included so the UI can render the class's schedule together.
 */
export async function listWeeklyTimetable({ from = null, to = null } = {}) {
  const sessionQuery = { status: { $in: ["scheduled", "live"] } };
  if (from || to) {
    sessionQuery.date = {};
    if (from) sessionQuery.date.$gte = new Date(from);
    if (to) sessionQuery.date.$lte = new Date(to);
  }

  const groups = await ClassGroup.find()
    .populate("teacher", "fullName email employeeRole employmentStatus photo")
    .lean();

  // One grouped query for ALL classes instead of one query per class (N+1).
  const sessions = await ClassSession.find({
    ...sessionQuery,
    classGroup: { $in: groups.map((g) => g._id) },
  })
    .populate("teacher", "fullName email")
    .populate("substituteTeacher", "fullName name email")
    .sort({ date: 1, startTime: 1 })
    .lean();

  const byGroup = new Map();
  for (const s of sessions) {
    const key = String(s.classGroup);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(s);
  }

  return groups.map((g) => {
    const entry = sanitizeClassGroup(g);
    entry.weeklySlots = g.weeklySlots || [];
    entry.effectiveSlots = effectiveSlots(g);
    // safeSession() expects a populated classGroup object; reuse the group we
    // already have instead of populating classGroup on every session document.
    entry.sessions = (byGroup.get(String(g._id)) || []).map((s) =>
      safeSession({ ...s, classGroup: { _id: g._id, code: g.code, subject: g.subject, grade: g.grade } })
    );
    return entry;
  });
}
/** Store a class's recurring weekly timetable (day/time slots) and teacher. */
export async function saveWeeklySlots({ classGroupId, slots = [], teacher = null }) {
  const group = await ClassGroup.findById(classGroupId);
  if (!group) throw new Error("Class group not found");

  const weeklySlots = normalizeWeeklySlots(slots) || [];
  group.weeklySlots = weeklySlots;
  // Keep the legacy singular schedule in sync (first slot) for older screens.
  if (weeklySlots.length) {
    group.schedule = {
      day: weeklySlots[0].day,
      startTime: weeklySlots[0].startTime,
      endTime: weeklySlots[0].endTime,
    };
  } else {
    // Wipe the legacy schedule too — otherwise effectiveSlots() keeps falling
    // back to a slot the user just deleted via the weeklySlots UI.
    group.schedule = { day: "", startTime: "", endTime: "" };
  }

  if (teacher !== undefined && teacher !== null && String(teacher).trim() !== "") {
    const teacherId = String(teacher).trim();
    if (!(await Teacher.findById(teacherId).select("_id").lean())) {
      throw new Error("Teacher not found");
    }
    group.teacher = teacherId;
  }
  await group.save();

  // Assigning (or changing) a teacher must also reach Moodle: the teacher has to
  // be enrolled in the class's mapped course, otherwise every calendar event we
  // push for that class is invisible to them.
  if (group.teacher) {
    try {
      const { syncClassGroupEnrollment } = await import("../moodle/syncTimetable.js");
      await syncClassGroupEnrollment({ classGroupId: group._id });
    } catch { /* best-effort; never block saving the timetable */ }
  }

  const populated = await ClassGroup.findById(group._id)
    .populate("teacher", "fullName email employeeRole employmentStatus photo")
    .lean();
  const entry = sanitizeClassGroup(populated);
  entry.weeklySlots = populated.weeklySlots || [];
  entry.effectiveSlots = effectiveSlots(populated);
  return entry;
}
/**
 * Tell the people who actually have to attend these classes that their
 * timetable is live: a durable in-app notification + socket event for the
 * teacher and every enrolled student, plus ONE summary email per recipient.
 *
 * Never throws — a notification/email failure must never undo a scheduled class.
 * Returns a small summary so the API response and UI can report delivery.
 */
export async function publishTimetable({ group, occurrences = [] }) {
  const summary = { notifiedTeacher: false, notifiedStudents: 0, pushSent: 0, emailsSent: 0, emailsSkipped: 0, errors: [] };
  try {
    if (!group || !occurrences.length) return summary;

    // De-duplicate identical date+time pairs, then sort chronologically so the
    // email reads like a timetable rather than a creation log.
    const seen = new Set();
    const entries = occurrences
      .filter((o) => {
        const key = `${o.date}T${o.startTime}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.date === b.date ? toMinutes(a.startTime) - toMinutes(b.startTime) : a.date < b.date ? -1 : 1));

    const rangeStart = entries[0].date;
    const rangeEnd = entries[entries.length - 1].date;
    const scope = `${group.subject || "Class"}${group.grade ? ` (${group.grade})` : ""} - ${group.code || ""}`.trim();
    const title = "Timetable published";
    const message = summaryLine(scope, entries.length, rangeStart, rangeEnd);

    const full = await ClassGroup.findById(group._id)
      .select("students teacher code subject grade")
      .populate("teacher", "fullName name email")
      .lean();
    const studentIds = (full?.students || []).map(String);
    const teacher = full?.teacher;

    // ── Durable + realtime: students ──────────────────────────────────────
    if (studentIds.length) {
      try {
        await notifyStudents({ studentIds, title, message, type: "info" });
        summary.notifiedStudents = studentIds.length;
      } catch (err) {
        summary.errors.push(`students-notify: ${err.message}`);
      }
      emitToStudents(studentIds, "timetable:published", {
        classGroup: group.code,
        subject: group.subject,
        grade: group.grade,
        count: entries.length,
        rangeStart,
        rangeEnd,
      });
    }

    // ── Durable + realtime: the assigned teacher ──────────────────────────
    if (teacher?._id) {
      try {
        await notifyTeacher({ teacherId: teacher._id, title, message, type: "info" });
        summary.notifiedTeacher = true;
      } catch (err) {
        summary.errors.push(`teacher-notify: ${err.message}`);
      }
      emitToTeacher(teacher._id, "timetable:published", {
        classGroup: group.code,
        count: entries.length,
        rangeStart,
        rangeEnd,
      });
    }

    // ── One record for the Tutor Manager notification centre ──────────────
    try {
      await notifyAllQaos({ title, message, type: "info", emitEvent: "timetable:published" });
    } catch (err) {
      summary.errors.push(`qao-notify: ${err.message}`);
    }

    // ── Web push: reachable even when the user has the app closed.
    // Push subscriptions are anonymous (endpoint only), so this is a
    // broadcast to all subscribed browsers — socket + durable legs above
    // already carry the per-user targeting.
    try {
      // Dynamic import (same pattern as routes/teacherRoutes.js): keeps the
      // runtime path intact while sidestepping the TS casing diagnostic TS1149
      // on this file name.
      // @ts-ignore TS1149: inconsistent project-folder casing in the compiler.
      const push = await import("../Controllers/pushNotificationController.js");
      const { sendPushToAll, sendPushToTeacher, sendPushToStudents } = push;
      const pushBody = message;
      let sent = 0;

      if (teacher?._id) {
        const r = await sendPushToTeacher(teacher._id, title, pushBody, "/teacher/dashboard").catch(() => null);
        if (r && typeof r.sent === "number") sent += r.sent;
      }
      if (studentIds.length) {
        const r = await sendPushToStudents(studentIds, title, pushBody, "/student/dashboard").catch(() => null);
        if (r && typeof r.sent === "number") sent += r.sent;
      }
      // Fallback for browsers that subscribed before userId was attached.
      if (sent === 0) {
        const r = await sendPushToAll(title, pushBody, "/dashboard").catch(() => null);
        if (r && typeof r.sent === "number") sent += r.sent;
      }
      summary.pushSent = sent;
    } catch (err) {
      summary.errors.push(`push: ${err.message}`);
    }

    // ── Summary emails (best-effort, bounded concurrency) ─────────────────
    const dashboardUrl = process.env.FRONTEND_URL || "https://studiesmasters-frontend.onrender.com";
    const recipients = [];

    if (teacher?.email) {
      recipients.push({ email: teacher.email, name: teacher.fullName || teacher.name, role: "teacher" });
    }
    if (studentIds.length) {
      const students = await Student.find({ _id: { $in: studentIds } }).select("fullName email").lean();
      for (const s of students) {
        if (s.email) recipients.push({ email: s.email, name: s.fullName, role: "student" });
      }
    }

    const emailResults = await mapWithConcurrency(recipients, EMAIL_CONCURRENCY, (r) =>
      sendTimetableEmail({
        to: r.email,
        name: r.name,
        role: r.role,
        scope,
        entries,
        rangeStart,
        rangeEnd,
        dashboardUrl,
      })
    );
    for (const r of emailResults) {
      if (r?.sent) summary.emailsSent += 1;
      else summary.emailsSkipped += 1;
    }
  } catch (err) {
    summary.errors.push(err.message);
  }
  return summary;
}

/**
 * Expand the class's recurring weekly slots into concrete ClassSessions over a
 * term date range and create / link a Google Calendar + Meet per session.
 * Dates are inclusive; sessions are created only for weekdays that map to a slot.
 */
export async function generateRangeSessions({ classGroupId, startDate, endDate }) {
  const group = await ClassGroup.findById(classGroupId).lean();
  if (!group) throw new Error("Class group not found");
  if (!group.teacher) {
    throw new Error("Assign a teacher to this class before generating its schedule.");
  }
  const slots = effectiveSlots(group);
  if (!slots.length) {
    throw new Error("This class has no weekly timetable slots yet. Add a day and time first.");
  }

  const start = toDateOnly(startDate);
  const end = toDateOnly(endDate);
  if (end.getTime() < start.getTime()) throw new Error("endDate must be on or after startDate");

  // Build the concrete occurrences (date + slot) we intend to schedule.
  // De-duplicated up front: a duplicated slot (e.g. "Monday 10:00" twice) must
  // not try to create — and double-book — the same session twice.
  const seenOccurrences = new Set();
  const occurrences = [];
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    const jsDay = cur.getDay();
    for (const slot of slots) {
      if (DAY_TO_JS[slot.day] === jsDay) {
        if (toMinutes(slot.endTime) <= toMinutes(slot.startTime)) continue;
        const date = toISODate(cur);
        const key = `${date}T${slot.startTime}`;
        if (seenOccurrences.has(key)) continue;
        seenOccurrences.add(key);
        occurrences.push({ date, startTime: slot.startTime, endTime: slot.endTime });
      }
    }
    cur.setDate(cur.getDate() + 1);
  }

  if (!occurrences.length) {
    throw new Error("No class dates fall inside the selected range for this timetable.");
  }

  // Create every session through the existing scheduler (conflict/availability
  // checked + Google Calendar / Meet generated per session). Failures for
  // individual dates never abort the rest of the batch, and concurrency is
  // bounded so a full term does not fire dozens of simultaneous API calls.
  const results = await mapWithConcurrency(occurrences, CREATE_CONCURRENCY, (o) =>
    createSession({
      classGroup: group._id,
      teacher: group.teacher,
      date: o.date,
      startTime: o.startTime,
      endTime: o.endTime,
      // One summary notification (durable + socket + push + email) is sent
      // by publishTimetable() below — suppress per-session fan-out here so
      // a 12-week term does not spam dozens of notifications.
      quiet: true,
    }).then(
      () => ({ ok: true }),
      (err) => ({ ok: false, err })
    )
  );

  let created = 0;
  let existing = 0;
  const failed = [];
  const createdOccurrences = [];
  results.forEach((r, i) => {
    if (r.ok) {
      created += 1;
      createdOccurrences.push(occurrences[i]);
    } else {
      const msg = String(r.err?.message || r.err || "unknown error");
      if (/duplicate/i.test(msg)) {
        existing += 1;
      } else {
        failed.push({ at: occurrences[i], reason: msg });
      }
    }
  });

  // ── Publish the new schedule ─────────────────────────────────────────────
  // Notify (durable + socket) the assigned teacher and every enrolled student,
  // and email each of them the generated timetable once. People whose sessions
  // were already duplicates were notified when they were first scheduled.
  const published = await publishTimetable({ group, occurrences: createdOccurrences });

  return {
    classGroup: { _id: group._id, code: group.code, subject: group.subject, grade: group.grade },
    slots,
    rangeStart: toISODate(start),
    rangeEnd: toISODate(end),
    occurrences: occurrences.length,
    created,
    existing,
    failed,
    published,
  };
}
export default { listWeeklyTimetable, saveWeeklySlots, generateRangeSessions, effectiveSlots, publishTimetable };