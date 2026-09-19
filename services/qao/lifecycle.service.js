// services/qao/lifecycle.service.js
//
// Automatic class lifecycle for the virtual classroom. Derives the display
// stage from the session's own date/time (no schema change — `status` keeps its
// existing enum) and performs the real transitions that ARE in the enum:
//
//   Scheduled -> Starting Soon (derived, 10 min before start)
//             -> Live          (status: scheduled -> live)
//             -> Completed     (status: live -> completed)
//             -> Archived      (derived, > 24h after end)
//
// Every transition emits role-room socket events (never global) and writes a
// durable Notification where appropriate. Reminders (24h / 1h / 10min) are
// emitted once per session per stage using an in-memory de-dupe set.
import ClassSession from "../../models/ClassSession.js";
import { emitToQaos, emitToTeacher, emitToStudents } from "./notify.js";
import { createNotification, notifyStudents } from "./notification.service.js";
import { sendClassReminderEmail } from "../../utils/sendTimetableEmail.js";
import { logQaoAction } from "./audit.service.js";
import { syncClassSession, CLASS_SYNC_ACTIONS } from "../moodle/syncClass.js";
import logger from "../../utils/logger.js";

export const STAGES = ["scheduled", "starting-soon", "live", "completed", "archived"];

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
}

/** minutes until the session starts (negative = already started) */
export function minutesUntilStart(session, now = new Date()) {
  const day = new Date(session.date);
  day.setHours(0, 0, 0, 0);
  const start = new Date(day.getTime() + toMinutes(session.startTime) * 60000);
  return Math.round((start.getTime() - now.getTime()) / 60000);
}

/** minutes since the session ended (negative = not ended yet) */
export function minutesSinceEnd(session, now = new Date()) {
  const day = new Date(session.date);
  day.setHours(0, 0, 0, 0);
  const end = new Date(day.getTime() + toMinutes(session.endTime) * 60000);
  return Math.round((now.getTime() - end.getTime()) / 60000);
}

/**
 * Derived lifecycle stage (does NOT mutate `status`).
 * Kept backward compatible: `status` remains the persisted truth.
 */
export function stageFor(session, now = new Date()) {
  if (!session?.date) return "scheduled";
  if (session.status === "cancelled") return "cancelled";
  if (session.status === "completed") {
    return minutesSinceEnd(session, now) > 24 * 60 ? "archived" : "completed";
  }
  if (session.status === "live") return "live";
  const until = minutesUntilStart(session, now);
  if (until <= 0 && minutesSinceEnd(session, now) < 0) return "live"; // in window
  if (until <= 10 && until > 0) return "starting-soon";
  return "scheduled";
}

const reminded = new Set(); // `${sessionId}:${stage}` de-dupe for reminders

async function groupStudentIds(classGroupId) {
  const Group = (await import("../../models/ClassGroup.js")).default;
  const g = await Group.findById(classGroupId).select("students").lean();
  return g?.students || [];
}
async function remind({ session, kind, minutesLabel }) {
  const key = `${session._id}:${kind}`;
  if (reminded.has(key)) return;
  reminded.add(key);

  const payload = {
    sessionId: session._id,
    subject: session.classGroup?.subject || "Class",
    grade: session.classGroup?.grade || "",
    startsInMinutes: minutesLabel,
    startTime: session.startTime,
  };

  // Teacher: durable notification + socket.
  const teacherId = session.substituteTeacher || session.teacher;
  if (teacherId) {
    try {
      await createNotification({
        userId: teacherId,
        role: "teacher",
        title: "Class reminder",
        message: `Your ${payload.subject} class starts in ${minutesLabel}.`,
        type: "info",
      });
      emitToTeacher(teacherId, "class:starting", payload);
    } catch { /* non-fatal */ }
  }

  // Students: durable notification + socket (their class group members), so the
  // reminder is still waiting in their dashboard bell when they come back online.
  try {
    const studentIds = await groupStudentIds(session.classGroup);
    if (studentIds.length) {
      await notifyStudents({
        studentIds,
        title: "Class reminder",
        message: `Your ${payload.subject}${payload.grade ? ` (${payload.grade})` : ""} class starts in ${minutesLabel}.`,
        type: "info",
      });
      emitToStudents(studentIds, "class:starting", payload);

      // Reminder emails are opt-in (CLASS_REMINDER_EMAILS=true) to avoid spam.
      if (String(process.env.CLASS_REMINDER_EMAILS || "false") === "true") {
        const Student = (await import("../../models/Student.js")).default;
        const students = await Student.find({ _id: { $in: studentIds } }).select("fullName email").lean();
        for (const s of students) {
          if (!s.email) continue;
          await sendClassReminderEmail({
            to: s.email,
            name: s.fullName,
            subject: payload.subject,
            grade: payload.grade,
            date: session.date,
            startTime: payload.startTime,
            minutesLabel,
          });
        }
      }
    }
  } catch { /* non-fatal */ }

  // QAO room: socket only (no durable copy to avoid notification spam).
  emitToQaos("class:starting", payload);
}

/** Transition scheduled -> live (auto) when the start time has arrived. */
async function goLive(session) {
  session.status = "live";
  await session.save();
  const payload = { sessionId: session._id, subject: session.classGroup?.subject || "Class" };
  const teacherId = session.substituteTeacher || session.teacher;
  const group = session.classGroup;
  emitToQaos("class:live", payload);
  emitToTeacher(teacherId, "class:live", payload);
  try { emitToStudents(await groupStudentIds(session.classGroup), "class:live", payload); } catch { /* non-fatal */ }
  try { await syncClassSession(session, { action: CLASS_SYNC_ACTIONS.UPDATED }); } catch { /* non-fatal */ }
  // Durable notifications (persistent + socket) for teacher and students
  try {
    await createNotification({ userId: teacherId, role: "teacher", title: "Class is live", message: `${group?.subject || "Class"} class is now live — join the session.`, type: "info" });
    const studentIds = await groupStudentIds(session.classGroup);
    if (studentIds.length) {
      await notifyStudents({ studentIds, title: "Class is live", message: `Your ${group?.subject || "Class"} class is now live — log in to join.`, type: "info" });
    }
  } catch { /* non-fatal */ }
  await logQaoAction({ action: "CLASS_AUTO_LIVE", resource: "ClassSession", resourceId: session._id, details: { by: "lifecycle" } });
}

/** Transition live -> completed (auto) when the end time has passed. */
async function goCompleted(session) {
  session.status = "completed";
  await session.save();
  const payload = { sessionId: session._id, subject: session.classGroup?.subject || "Class" };
  const teacherId = session.substituteTeacher || session.teacher;
  const group = session.classGroup;
  emitToQaos("class:ended", payload);
  emitToTeacher(teacherId, "class:ended", payload);
  try { emitToStudents(await groupStudentIds(session.classGroup), "class:ended", payload); } catch { /* non-fatal */ }
  try { await syncClassSession(session, { action: CLASS_SYNC_ACTIONS.UPDATED }); } catch { /* non-fatal */ }
  // Durable notifications (persistent + socket) for teacher and students
  try {
    await createNotification({ userId: teacherId, role: "teacher", title: "Class completed", message: `${group?.subject || "Class"} class has ended — recording and summary will be available shortly.`, type: "info" });
    const studentIds = await groupStudentIds(session.classGroup);
    if (studentIds.length) {
      await notifyStudents({ studentIds, title: "Class completed", message: `Your ${group?.subject || "Class"} class has ended — check your dashboard for the recording and summary.`, type: "info" });
    }
  } catch { /* non-fatal */ }
  await logQaoAction({ action: "CLASS_AUTO_COMPLETED", resource: "ClassSession", resourceId: session._id, details: { by: "lifecycle" } });
}

// ── Plan-duration expiry reminders ───────────────────────────────────────────
// Warns students when their study plan (finishDate) is about to expire so they
// renew: at 7 days, 3 days, 1 day before, and once when expired. De-duped per
// student/bucket/day so the tick can run as often as it likes.
const expiryReminded = new Set(); // `${studentId}:${bucket}:${yyyy-mm-dd}`

async function checkPlanExpiry(now = new Date()) {
  try {
    const Student = (await import("../../models/Student.js")).default;
    const { notifyStudent } = await import("./notification.service.js");
    const { emitToStudent } = await import("./notify.js");
    const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const students = await Student.find({ finishDate: { $ne: null, $lte: horizon } })
      .select("fullName finishDate")
      .lean();
    const today = now.toISOString().slice(0, 10);
    let sent = 0;
    for (const s of students) {
      if (!s.finishDate) continue;
      const daysLeft = Math.ceil((new Date(s.finishDate).getTime() - now.getTime()) / 86400000);
      const bucket = daysLeft < 0 ? "expired" : daysLeft <= 1 ? "1d" : daysLeft <= 3 ? "3d" : "7d";
      const key = `${s._id}:${bucket}:${today}`;
      if (expiryReminded.has(key)) continue;
      expiryReminded.add(key);
      const title = daysLeft < 0
        ? "Plan expired — renew now"
        : daysLeft <= 1
          ? "Your plan expires tomorrow"
          : `Your plan expires in ${daysLeft} day(s)`;
      const message = daysLeft < 0
        ? `Your StudiesMasters plan expired on ${new Date(s.finishDate).toLocaleDateString()}. Renew now to keep your live classes, Moodle access and tutor support.`
        : `Your StudiesMasters plan ends on ${new Date(s.finishDate).toLocaleDateString()} (${daysLeft} day(s) left). Renew soon so you don't lose access to your live classes on Moodle.`;
      try {
        await notifyStudent({ studentId: s._id, title, message, type: daysLeft < 0 ? "warning" : "info" });
        emitToStudent(String(s._id), "notification:new", { title, message, createdAt: new Date().toISOString() });
        sent += 1;
      } catch { /* non-fatal */ }
    }
    return sent;
  } catch { return 0; }
}

/** One scheduler pass. Safe to call repeatedly; every step is non-fatal. */
export async function runLifecycleTick() {
  const now = new Date();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const horizon = new Date(now.getTime() + 25 * 60 * 60 * 1000); // 25h window

  const sessions = await ClassSession.find({
    date: { $gte: new Date(dayStart.getTime() - 24 * 60 * 60 * 1000), $lt: horizon },
    status: { $in: ["scheduled", "live"] },
  })
    .populate("classGroup", "code subject grade curriculum")
    .populate("teacher", "fullName")
    .populate("substituteTeacher", "fullName")
    .lean();

  let transitions = 0;
  for (const s of sessions) {
    const mutable = await ClassSession.findById(s._id);
    if (!mutable) continue;
    const until = minutesUntilStart(s, now);
    const sinceEnd = minutesSinceEnd(s, now);

    if (mutable.status === "scheduled") {
      if (until <= 24 * 60 && until > 60) await remind({ session: s, kind: "day-before", minutesLabel: "24 hours" });
      if (until <= 60 && until > 30) await remind({ session: s, kind: "r1h", minutesLabel: "1 hour" });
      if (until <= 30 && until > 0) await remind({ session: s, kind: "r30m", minutesLabel: "30 minutes" });
      if (until <= 0 && sinceEnd < 0) { await goLive(mutable); transitions++; }
    } else if (mutable.status === "live") {
      if (sinceEnd >= 0) { await goCompleted(mutable); transitions++; }
    }
  }
  return { checked: sessions.length, transitions, expiryAlerts: await checkPlanExpiry(now) };
}

let schedulerStarted = false;
/** Start the background lifecycle scheduler (idempotent). */
export function startLifecycleScheduler({ intervalMs = 60000, enabled = true } = {}) {
  if (schedulerStarted || !enabled) return { started: false };
  schedulerStarted = true;
  setInterval(() => {
    runLifecycleTick().catch((err) => logger.warn(`[LIFECYCLE] tick failed: ${err.message}`));
  }, Math.max(intervalMs, 15000));
  logger.info("[LIFECYCLE] class lifecycle scheduler started");
  return { started: true };
}

export default { stageFor, runLifecycleTick, startLifecycleScheduler, STAGES };