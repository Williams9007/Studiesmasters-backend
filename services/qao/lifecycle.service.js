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
import { createNotification } from "./notification.service.js";
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

  // Students: socket only (their class group members).
  try {
    emitToStudents(await groupStudentIds(session.classGroup), "class:starting", payload);
  } catch { /* non-fatal */ }

  // QAO room: socket only (no durable copy to avoid notification spam).
  emitToQaos("class:starting", payload);
}

/** Transition scheduled -> live (auto) when the start time has arrived. */
async function goLive(session) {
  session.status = "live";
  await session.save();
  const payload = { sessionId: session._id, subject: session.classGroup?.subject || "Class" };
  emitToQaos("class:live", payload);
  emitToTeacher(session.substituteTeacher || session.teacher, "class:live", payload);
  try { emitToStudents(await groupStudentIds(session.classGroup), "class:live", payload); } catch { /* non-fatal */ }
  try { await syncClassSession(session, { action: CLASS_SYNC_ACTIONS.UPDATED }); } catch { /* non-fatal */ }
  await logQaoAction({ action: "CLASS_AUTO_LIVE", resource: "ClassSession", resourceId: session._id, details: { by: "lifecycle" } });
}

/** Transition live -> completed (auto) when the end time has passed. */
async function goCompleted(session) {
  session.status = "completed";
  await session.save();
  const payload = { sessionId: session._id, subject: session.classGroup?.subject || "Class" };
  emitToQaos("class:ended", payload);
  emitToTeacher(session.substituteTeacher || session.teacher, "class:ended", payload);
  try { emitToStudents(await groupStudentIds(session.classGroup), "class:ended", payload); } catch { /* non-fatal */ }
  try { await syncClassSession(session, { action: CLASS_SYNC_ACTIONS.UPDATED }); } catch { /* non-fatal */ }
  await logQaoAction({ action: "CLASS_AUTO_COMPLETED", resource: "ClassSession", resourceId: session._id, details: { by: "lifecycle" } });
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
      if (until <= 24 * 60 && until > 60) await remind({ session: s, kind: "r24h", minutesLabel: "24 hours" });
      if (until <= 60 && until > 10) await remind({ session: s, kind: "r1h", minutesLabel: "1 hour" });
      if (until <= 10 && until > 0) await remind({ session: s, kind: "r10m", minutesLabel: "10 minutes" });
      if (until <= 0 && sinceEnd < 0) { await goLive(mutable); transitions++; }
    } else if (mutable.status === "live") {
      if (sinceEnd >= 0) { await goCompleted(mutable); transitions++; }
    }
  }
  return { checked: sessions.length, transitions };
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