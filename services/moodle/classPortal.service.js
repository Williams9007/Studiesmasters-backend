// services/moodle/classPortal.service.js
//
// Enables the StudiesMasters Virtual Classroom to be LAUNCHED FROM INSIDE Moodle,
// while MongoDB (StudiesMasters backend) remains the single source of truth for
// scheduling, Google Meet generation, attendance, and audit.
//
// Trust model:
//   - Moodle cannot hold a JWT, so Moodle calls these endpoints using the SAME
//     shared-secret HMAC signature scheme used by the SSO handshake.
//   - The Moodle plugin (which holds the shared secret) signs:
//         username | email | timestamp | nonce | course
//     exactly as sso.php expects, and the backend verifies it timing-safe
//     against every rotation secret and enforces freshness. The nonce is
//     one-time either way: nonces WE minted (SSO URLs, tooling) are consumed
//     by claimNonce(); the nonce the PLUGIN mints itself per request (it has
//     no round-trip to get one from us) is admitted once by reserveNonce()
//     and rejected as a replay on every later sight.
//   - The signed `username` (sm_s_<hex> / sm_t_<hex>) resolves to the Mongo
//     principal via MoodleLink, so the backend re-applies the same enrollment
//     + assignment gates as the React meet routes. No PII is ever returned.

import { isFresh } from "./verifySSO.js";
import { verifyPayload, signPayload } from "./config.js";
import { generateNonce, claimNonce, reserveNonce } from "./store.js";
import { audit } from "./audit.js";
import ClassSession from "../../models/ClassSession.js";
import ClassGroup from "../../models/ClassGroup.js";
import MoodleLink from "../../models/MoodleLink.js";
import { recordAttendance, regenerateMeeting, endSession } from "../qao/scheduling.service.js";
import { emitToAdmin, emitToQaos, emitToTeacher, emitToStudents } from "../qao/notify.js";

const detectKind = (u) => String(u || "").startsWith("sm_t") ? "teacher" : "student";

/**
 * Verify a signed class request. Returns { ok, principalId, role, link } or a
 * failed verdict ({ ok:false, reason }). `course` is included to keep the wire
 * contract identical to the SSO payload; it defaults to 0.
 */
export async function verifyClassRequest({ username, email, timestamp, nonce, course = 0, signature, req = null }) {
  const user = String(username || "").trim().toLowerCase();
  const mail = String(email || "").trim();
  const courseValue = Number(course) || 0;
  const fresh = isFresh(timestamp);
  if (!fresh.ok) return { ok: false, reason: fresh.reason, username: user };
  const payload = `${user}|${mail}|${timestamp}|${nonce}|${courseValue}`;
  const sigOk = verifyPayload(payload, signature);
  if (!sigOk.ok) {
    await audit({ action: "CLASS_ACCESS_DENIED", outcome: "failure", failure: "signature mismatch", req, moodleUsername: user }).catch(() => {});
    return { ok: false, reason: "signature mismatch", step: "signature" };
  }
  // Resolve the principal BEFORE the nonce gate: a plugin-minted nonce is
  // reserved against its owner, and a username with no MoodleLink has no
  // principal to authorize — never let it through with a null principalId
  // (downstream $or:{null} queries would widen to unassigned sessions).
  const link = await MoodleLink.findOne({ moodleUsername: user }).lean();
  const principalRef = link?.studentRef || link?.teacherRef || null;
  if (!principalRef) {
    await audit({ action: "CLASS_ACCESS_DENIED", outcome: "failure", failure: "no MoodleLink for username", req, moodleUsername: user }).catch(() => {});
    return { ok: false, reason: "unknown_user", step: "identity" };
  }
  const kind = detectKind(user);
  const claimed = await claimNonce({ nonce, kind });
  if (!claimed.ok) {
    // Nonces WE minted that report reused/expired stay rejected. "unknown" /
    // "not found" means the backend never minted this nonce — that is the
    // Moodle plugin, which signs with a nonce IT generated per request
    // (index.php call_backend). Admit it on FIRST sight only; reserveNonce
    // registers it atomically so every later replay fails as "reused".
    const neverSeen = claimed.reason === "unknown" || String(claimed.reason).includes("not found");
    const reserved = neverSeen
      ? await reserveNonce({ nonce, kind, studentRef: principalRef })
      : { ok: false, reason: claimed.reason };
    if (!reserved.ok) {
      await audit({ action: "CLASS_ACCESS_DENIED", outcome: "failure", failure: `nonce ${reserved.reason}`, req, moodleUsername: user }).catch(() => {});
      return { ok: false, reason: `nonce_${reserved.reason}`, step: "nonce" };
    }
  }
  const role = link?.role || detectKind(user);
  return { ok: true, role, principalId: principalRef.toString(), username: user, email: mail, link };
}

/**
 * Build a signed request for the given principal. The Moodle plugin does the
 * same on its side (it holds the shared secret); this is exposed for tooling/
 * self-tests and for the React surface if ever needed.
 */
export async function buildSignedRequest({ role, id, email }) {
  const link = await MoodleLink.findOne(role === "teacher" ? { teacherRef: id } : { studentRef: id }).lean();
  const { nonce } = await generateNonce({ studentRef: id, kind: role });
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${link?.moodleUsername || ""}|${String(email || "").trim()}|${timestamp}|${nonce}|0`;
  const { sign: signature } = signPayload(payload);
  return {
    username: link?.moodleUsername || "",
    email: String(email || "").trim(),
    timestamp: String(timestamp),
    nonce,
    course: "0",
    signature,
  };
}
/**
 * List sessions visible to a user (students = enrolled groups, teachers =
 * assigned or substitute). Returns display-safe fields; signed caller is
 * already trusted, and meeting links are only returned via join().
 */
export async function listUserSessions({ role, principalId }) {
  let sessions;
  if (role === "teacher") {
    sessions = await ClassSession.find({
      $or: [{ teacher: principalId }, { substituteTeacher: principalId }],
      status: { $in: ["scheduled", "live"] },
    })
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .populate("substituteTeacher", "fullName")
      .sort({ date: 1, startTime: 1 })
      .lean();
  } else {
    const groups = await ClassGroup.find({ students: principalId }).select("_id").lean();
    sessions = await ClassSession.find({
      classGroup: { $in: groups.map((g) => g._id) },
      status: { $in: ["scheduled", "live"] },
    })
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .populate("substituteTeacher", "fullName")
      .sort({ date: 1, startTime: 1 })
      .lean();
  }
  const today = new Date().toISOString().slice(0, 10);
  return (sessions || [])
    .filter((s) => new Date(s.date).toISOString().slice(0, 10) >= today)
    .map((s) => ({
      sessionId: s._id,
      subject: s.classGroup?.subject || "",
      grade: s.classGroup?.grade || "",
      curriculum: s.classGroup?.curriculum || "",
      teacher: s.substituteTeacher?.fullName || s.teacher?.fullName || "",
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      meetingStatus: s.meetingStatus,
      // Teachers always see their link (they manage the meeting); students only
      // once the class is live — the waiting room must keep gating early access.
      meetingLink: role === "teacher" || s.status === "live"
        ? (s.meetingLink || s.googleMeet?.meetingLink || "")
        : "",
      // Students see join only when live; teachers manage the meeting.
      canJoin: role === "student" ? s.status === "live" : true,
      canStart: role === "teacher" && (s.status === "scheduled" || s.status === "live"),
    }));
}

/** Student joins — waiting-room aware. Returns the Meet link ONLY when live. */
export async function joinSession({ role, principalId, sessionId, waiting = true }) {
  const session = await ClassSession.findById(sessionId)
    .populate("classGroup", "students subject grade curriculum")
    .populate("teacher", "fullName")
    .populate("substituteTeacher", "fullName")
    .lean();
  if (!session) return { error: { status: 404, message: "Session not found" } };
  const base = {
    sessionId: session._id,
    subject: session.classGroup?.subject || "",
    grade: session.classGroup?.grade || "",
    teacher: session.substituteTeacher?.fullName || session.teacher?.fullName || "",
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
  };
  // Teacher (assigned or substitute): they MANAGE the meeting, so they get the
  // link directly — no student waiting room, no enrollment-in-students check
  // (teachers are not in group.students, which used to 403 them out of Moodle),
  // and no student attendance row is recorded for them.
  if (role === "teacher") {
    const assigned =
      String(session.teacher?._id || session.teacher || "") === String(principalId) ||
      String(session.substituteTeacher?._id || session.substituteTeacher || "") === String(principalId);
    if (!assigned) return { error: { status: 403, message: "You are not assigned to this class" } };
    if (session.status === "completed" || session.status === "cancelled") {
      return { error: { status: 400, message: "This class is no longer joinable" } };
    }
    return {
      ok: true,
      session: base,
      meeting: { link: session.meetingLink || session.googleMeet?.meetingLink || "", status: session.meetingStatus },
    };
  }
  const group = session.classGroup;
  const enrolled = group && Array.isArray(group.students) && group.students.some((id) => String(id) === String(principalId));
  if (!enrolled) return { error: { status: 403, message: "You are not enrolled in this class" } };
  if (session.status === "completed" || session.status === "cancelled") {
    return { error: { status: 400, message: "This class is no longer joinable" } };
  }
  // Waiting room: class not live yet — no link, no attendance. The Moodle page
  // keeps the student "in waiting room" and calls join again once it becomes live.
  if (waiting && session.status !== "live") {
    return { ok: true, waiting: true, session: base };
  }
  await recordAttendance(session._id, { student: principalId, joinedAt: new Date(), source: "client" });
  return {
    ok: true,
    session: base,
    meeting: { link: session.meetingLink || session.googleMeet?.meetingLink || "", status: session.meetingStatus },
  };
}

/** Student leaves — close their attendance window. */
export async function leaveSession({ role, principalId, sessionId, joinedAt = null }) {
  const session = await ClassSession.findById(sessionId).populate("classGroup", "students").lean();
  if (!session) return { error: { status: 404, message: "Session not found" } };
  const group = session.classGroup;
  const enrolled = group && Array.isArray(group.students) && group.students.some((id) => String(id) === String(principalId));
  if (!enrolled) return { error: { status: 403, message: "You are not enrolled in this class" } };
  const updated = await recordAttendance(session._id, {
    student: principalId,
    joinedAt: joinedAt ? new Date(joinedAt) : null,
    leftAt: new Date(),
    source: "client",
  });
  return { ok: true, attendance: updated };
}
/** Teacher starts a class (marks live) and returns the link. */
export async function startSession({ role, principalId, sessionId }) {
  if (role !== "teacher") return { error: { status: 403, message: "Only a teacher can start a class" } };
  const raw = await ClassSession.findById(sessionId).lean();
  if (!raw) return { error: { status: 404, message: "Session not found" } };
  const isAssigned =
    String(raw.teacher || "") === String(principalId) ||
    String(raw.substituteTeacher || "") === String(principalId);
  if (!isAssigned) return { error: { status: 403, message: "You are not assigned to this class" } };
  if (raw.status === "cancelled") return { error: { status: 400, message: "This class is cancelled" } };
  if (!raw.meetingLink) await regenerateMeeting(raw._id, { actor: principalId });
  await ClassSession.findByIdAndUpdate(raw._id, { status: "live" });
  emitToAdmin("class:live", { sessionId: raw._id });
  emitToQaos("class:live", { sessionId: raw._id });
  const fresh = await ClassSession.findById(raw._id).populate("classGroup", "students").lean();
  emitToStudents(fresh?.classGroup?.students || [], "class:live", { sessionId: raw._id });
  emitToTeacher(raw.teacher, "class:live", { sessionId: raw._id });
  const updated = await ClassSession.findById(raw._id).lean();
  return { ok: true, session: { sessionId: raw._id, status: "live" }, meeting: { status: updated?.meetingStatus || "pending", link: updated?.meetingLink || "" } };
}

/** Teacher ends a class (marks completed). */
export async function endSessionForMoodle({ role, principalId, sessionId }) {
  if (role !== "teacher") return { error: { status: 403, message: "Only a teacher can end a class" } };
  const raw = await ClassSession.findById(sessionId).lean();
  if (!raw) return { error: { status: 404, message: "Session not found" } };
  const isAssigned =
    String(raw.teacher || "") === String(principalId) ||
    String(raw.substituteTeacher || "") === String(principalId);
  if (!isAssigned) return { error: { status: 403, message: "You are not assigned to this class" } };
  await endSession(raw._id, { actor: principalId });
  return { ok: true, session: { sessionId: raw._id, status: "completed" } };
}

// ---------------------------------------------------------------------------
// Phase 7 — Unified dashboard / attendance / recording / regenerate / alerts
// ---------------------------------------------------------------------------

const todayStart = () => {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/**
 * Build the unified dashboard for the current role.
 * Returns { role, liveNow[], upcoming[], past[], waitingSessionId|null }.
 * Display-safe fields. `meetingLink` is included for TEACHERS always (they
 * manage the meeting and must find it on the Moodle dashboard) and for STUDENTS
 * only once the class is live — join() remains the waiting-room gate for
 * everyone else.
 */
export async function dashboardForUser({ role, principalId }) {
  const today = todayStart();
  const baseQ = role === "teacher"
    ? { $or: [{ teacher: principalId }, { substituteTeacher: principalId }] }
    : {};

  let sessions;
  if (role === "teacher") {
    sessions = await ClassSession.find(baseQ)
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .populate("substituteTeacher", "fullName")
      .sort({ date: 1, startTime: 1 })
      .lean();
  } else {
    const groups = await ClassGroup.find({ students: principalId }).select("_id").lean();
    sessions = await ClassSession.find({ classGroup: { $in: groups.map((g) => g._id) } })
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .populate("substituteTeacher", "fullName")
      .sort({ date: 1, startTime: 1 })
      .lean();
  }

  const liveNow = [];
  const upcoming = [];
  const history = [];
  for (const s of sessions) {
    const dateStr = new Date(s.date).toISOString().slice(0, 10);
    const item = {
      sessionId: s._id,
      subject: s.classGroup?.subject || "",
      grade: s.classGroup?.grade || "",
      curriculum: s.classGroup?.curriculum || "",
      code: s.classGroup?.code || "",
      teacher: s.substituteTeacher?.fullName || s.teacher?.fullName || "",
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      meetingStatus: s.meetingStatus,
      meetingLink: role === "teacher" || s.status === "live"
        ? (s.meetingLink || s.googleMeet?.meetingLink || "")
        : "",
      notes: s.notes || "",
      recordingAvailable: Boolean(s.recordingLink),
    };
    if (s.status === "live") liveNow.push(item);
    else if (s.status === "scheduled" && dateStr >= today) upcoming.push(item);
    else history.push(item);
  }
  return { role, liveNow, upcoming, history };
}
/** Attendance history — student sees their own; teacher sees the roster. */
export async function attendanceHistoryForUser({ role, principalId }) {
  const today = todayStart();
  let sessions;
  if (role === "teacher") {
    sessions = await ClassSession.find({
      $or: [{ teacher: principalId }, { substituteTeacher: principalId }],
      status: { $in: ["completed", "live", "cancelled"] },
    })
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .populate("substituteTeacher", "fullName")
      .sort({ date: -1 })
      .limit(60)
      .lean();
    return {
      role,
      rows: (sessions || []).map((s) => ({
        sessionId: s._id,
        subject: s.classGroup?.subject || "",
        grade: s.classGroup?.grade || "",
        teacher: s.substituteTeacher?.fullName || s.teacher?.fullName || "",
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        status: s.status,
        present: (s.attendance || []).length,
        duration: s.durationMinutes,
      })),
    };
  }
  // student
  const groups = await ClassGroup.find({ students: principalId }).select("_id").lean();
  sessions = await ClassSession.find({
    classGroup: { $in: groups.map((g) => g._id) },
    status: { $in: ["completed", "live", "cancelled"] },
  })
    .populate("classGroup", "code subject grade curriculum")
    .populate("teacher", "fullName")
    .populate("substituteTeacher", "fullName")
    .sort({ date: -1 })
    .limit(60)
    .lean();
  return {
    role,
    rows: (sessions || []).map((s) => {
      const rec = (s.attendance || []).find((a) => String(a.student || "") === String(principalId)) || {};
      return {
        sessionId: s._id,
        subject: s.classGroup?.subject || "",
        grade: s.classGroup?.grade || "",
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        status: s.status,
        present: Boolean(rec.joinedAt),
        joinedAt: rec.joinedAt || null,
        leftAt: rec.leftAt || null,
        duration: rec.duration || 0,
      };
    }),
  };
}

/** Recording library — classes (for this user's scope) that have a recording. */
export async function recordingHistoryForUser({ role, principalId }) {
  let query;
  if (role === "teacher") {
    query = { $or: [{ teacher: principalId }, { substituteTeacher: principalId }], recordingLink: { $ne: "" } };
  } else {
    const groups = await ClassGroup.find({ students: principalId }).select("_id").lean();
    query = { classGroup: { $in: groups.map((g) => g._id) }, recordingLink: { $ne: "" } };
  }
  const sessions = await ClassSession.find(query)
    .populate("classGroup", "code subject grade curriculum")
    .populate("teacher", "fullName")
    .populate("substituteTeacher", "fullName")
    .sort({ date: -1 })
    .limit(50)
    .lean();
  return (sessions || []).map((s) => ({
    sessionId: s._id,
    subject: s.classGroup?.subject || "",
    grade: s.classGroup?.grade || "",
    teacher: s.substituteTeacher?.fullName || s.teacher?.fullName || "",
    date: s.date,
    duration: s.durationMinutes,
    recordingLink: s.recordingLink,
  }));
}

/** Teacher regenerates the Meeting link; Moodle is re-synced + students alerted. */
export async function regenerateSession({ role, principalId, sessionId }) {
  if (role !== "teacher") return { error: { status: 403, message: "Only a teacher can regenerate this meeting" } };
  const raw = await ClassSession.findById(sessionId).lean();
  if (!raw) return { error: { status: 404, message: "Session not found" } };
  const isAssigned =
    String(raw.teacher || "") === String(principalId) ||
    String(raw.substituteTeacher || "") === String(principalId);
  if (!isAssigned) return { error: { status: 403, message: "You are not assigned to this class" } };
  try {
    const updated = await regenerateMeeting(raw._id, { actor: principalId });
    const group = await ClassGroup.findById(raw.classGroup).select("students").lean();
    emitToStudents(group?.students || [], "meeting:updated", {
      sessionId: raw._id,
      meetingStatus: updated?.meetingStatus,
    });
    return { ok: true, meeting: { status: updated?.meetingStatus || "pending", link: updated?.meetingLink || "" } };
  } catch (err) {
    return { error: { status: 500, message: err.message } };
  }
}

/** Recent notifications for a user (from the Notification collection). */
export async function notificationsForUser({ role, principalId, limit = 20 }) {
  try {
    const Notification = (await import("../../models/Notification.js")).default;
    const rows = await Notification.find({ userId: principalId })
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 20, 50))
      .lean();
    return (rows || []).map((n) => ({
      id: n._id,
      title: n.title || "",
      message: n.message,
      type: n.type || "info",
      read: !!n.read,
      link: n.link || null,
      createdAt: n.createdAt,
    }));
  } catch { return []; }
}
const classPortal = {
  verifyClassRequest, buildSignedRequest, listUserSessions,
  joinSession, leaveSession, startSession, endSessionForMoodle,
  dashboardForUser, attendanceHistoryForUser, recordingHistoryForUser,
  regenerateSession, notificationsForUser,
};
export default classPortal;