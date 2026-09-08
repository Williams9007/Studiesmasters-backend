import ClassSession from "../../models/ClassSession.js";
import ClassGroup from "../../models/ClassGroup.js";
import Teacher from "../../models/teacher.js";
import { emitToQaos, emitToTeacher, emitToStudents, emitToAdmin } from "./notify.js";
import { logQaoAction } from "./audit.service.js";
import { createMeeting } from "../google/meet.service.js";
import { syncClassSession, CLASS_SYNC_ACTIONS } from "../moodle/syncClass.js";

const SAFE_TEACHER_FIELDS = "fullName email employeeRole employmentStatus photo";
const SAFE_GROUP_FIELDS = "code curriculum grade subject capacity status schedule meetingLink";

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
}

function dayBounds(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const next = new Date(day);
  next.setDate(next.getDate() + 1);
  return [day, next];
}

export async function listSessions({ from, to, teacherId, classGroupId, status } = {}) {
  const query = {};
  if (from || to) {
    query.date = {};
    if (from) query.date.$gte = new Date(from);
    if (to) query.date.$lt = new Date(to);
  }
  if (teacherId) query.$or = [{ teacher: teacherId }, { substituteTeacher: teacherId }];
  if (classGroupId) query.classGroup = classGroupId;
  if (status) query.status = status;
  return ClassSession.find(query)
    .populate("teacher", SAFE_TEACHER_FIELDS)
    .populate("substituteTeacher", SAFE_TEACHER_FIELDS)
    .populate("classGroup", SAFE_GROUP_FIELDS)
    .sort({ date: 1, startTime: 1 })
    .lean();
}

export async function todaySessions() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return listSessions({ from: start.toISOString(), to: end.toISOString() });
}

export async function createSession(data = {}) {
  const { classGroup, teacher, date, startTime, endTime, meetingLink, notes } = data;
  if (!classGroup || !teacher || !date || !startTime || !endTime) {
    throw new Error("classGroup, teacher, date, startTime and endTime are required");
  }
  if (toMinutes(endTime) <= toMinutes(startTime)) {
    throw new Error("endTime must be after startTime");
  }
  const [group, teacherDoc] = await Promise.all([
    ClassGroup.findById(classGroup).select("_id code meetingLink subject grade curriculum").lean(),
    Teacher.findById(teacher).select("_id fullName").lean(),
  ]);
  if (!group) throw new Error("Class group not found");
  if (!teacherDoc) throw new Error("Teacher not found");

  // Admin/QM override bypasses conflict & availability checks (emergency
  // replacement) but ALWAYS requires a reason and writes an audit record.
  const isOverride = data.override === true || data.override === "true";
  const overrideReason = isOverride ? String(data.reason || "").trim() : "";
  if (isOverride && !overrideReason) {
    throw new Error("reason is required when overriding a schedule");
  }

  // Validation order: duplicates -> teacher overlap -> availability window
  if (!isOverride) await assertNoDuplicate({ classGroup, date, startTime });
  if (!isOverride) await assertNoConflict({ teacher, date, startTime, endTime });
  if (!isOverride) await assertAvailability({ teacher, date, startTime, endTime });

  const session = await ClassSession.create({
    classGroup,
    teacher,
    date: new Date(date),
    startTime,
    endTime,
    meetingLink: meetingLink || group.meetingLink || "",
    notes: notes || "",
  });

// ---- Admin/QM override audit (every override is recorded) ---------------
  if (isOverride) {
    await logQaoAction({
      action: "schedule.override",
      resource: "ClassSession",
      resourceId: session._id,
      details: { reason: overrideReason, overridden: { teacher: String(teacher), date: session.date, startTime, endTime } },
    });
  }

  // ---- Automatic Google Meet generation (graceful, never blocks creation) --
  const meeting = await createMeeting({
    subject: group.subject || "",
    grade: group.grade || "",
    teacherName: teacherDoc.fullName || "",
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
    sessionId: session._id,
    rollNumber: group.code,
  });
  if (meeting.meetingLink) {
    session.meetingLink = meeting.meetingLink;
    session.meetingCode = meeting.meetingCode || "";
    session.conferenceId = meeting.conferenceId || "";
    session.calendarEventId = meeting.calendarEventId || "";
    session.meetingStatus = meeting.meetingStatus || "pending";
    await session.save();
  } else if (session.meetingStatus !== "ready") {
    session.meetingStatus = "pending";
    await session.save();
  }

  emitToQaos("meeting:updated", { sessionId: session._id, meetingStatus: session.meetingStatus, meetingLink: session.meetingLink });
  emitToQaos(session.meetingStatus === "ready" ? "meeting:generated" : "meeting:failed", { sessionId: session._id, meetingStatus: session.meetingStatus });
  emitToAdmin("meeting:updated", { sessionId: session._id, meetingStatus: session.meetingStatus });

  // ---- Enrolled students get the class:created notification (role rooms) ---
  const groupDoc = await ClassGroup.findById(classGroup).select("students").lean();
  const studentIds = groupDoc?.students || [];
  emitToStudents(studentIds, "class:created", {
    sessionId: session._id,
    classGroup: group.code,
    date: session.date,
    meetingLink: session.meetingLink,
  });

  // ---- Moodle display sync (backend still the source of truth) -------------
  try {
    await syncClassSession(session, {
      action: session.meetingStatus === "ready" ? CLASS_SYNC_ACTIONS.MEETING_READY : CLASS_SYNC_ACTIONS.CREATED,
    });
  } catch { /* display sync must never break scheduling */ }

  emitToQaos("schedule:created", { sessionId: session._id, classGroup: group.code, date: session.date });
  emitToQaos("class:upcoming", { sessionId: session._id, classGroup: group.code, date: session.date });
  emitToTeacher(teacher, "class:upcoming", { sessionId: session._id, classGroup: group.code, date: session.date });
  await logQaoAction({
    action: "SESSION_CREATED",
    resource: "ClassSession",
    resourceId: session._id,
    details: { classGroup: group.code, teacher: String(teacher), date: session.date, startTime, endTime },
  });
  return ClassSession.findById(session._id)
    .populate("teacher", SAFE_TEACHER_FIELDS)
    .populate("classGroup", SAFE_GROUP_FIELDS)
    .lean();
}

// Duplicate = same class group already has an active session at the same date
// and start time.
export async function assertNoDuplicate({ classGroup, date, startTime, ignoreSessionId = null }) {
  const [day, next] = dayBounds(date);
  const dup = await ClassSession.findOne({
    _id: ignoreSessionId ? { $ne: ignoreSessionId } : undefined,
    classGroup,
    date: { $gte: day, $lt: next },
    startTime,
    status: { $in: ["scheduled", "live"] },
  })
    .select("_id")
    .lean();
  if (dup) {
    const err = new Error("Duplicate session: this class group already has an active session at this date and time");
    err.conflictWith = dup._id;
    throw err;
  }
}

// Availability conflict: if the teacher configured weekly availability[], the
// session day must be covered and the window must fit inside one slot.
// No availability configured = unrestricted (backwards compatible).
export async function assertAvailability({ teacher, date, startTime, endTime }) {
  const t = await Teacher.findById(teacher).select("fullName availability").lean();
  if (!t) return;
  const slots = (t.availability || []).filter((s) => s && s.day && s.start && s.end);
  if (!slots.length) return;
  const dayName = new Date(date).toLocaleDateString("en-US", { weekday: "long" });
  const daySlots = slots.filter((s) => String(s.day).toLowerCase() === dayName.toLowerCase());
  if (!daySlots.length) {
    const err = new Error(`Availability conflict: ${t.fullName || "this teacher"} has no availability on ${dayName}`);
    err.conflictType = "availability";
    throw err;
  }
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  const covered = daySlots.some((s) => start >= toMinutes(s.start) && end <= toMinutes(s.end));
  if (!covered) {
    const err = new Error(`Availability conflict: outside ${t.fullName || "this teacher"}'s available hours on ${dayName}`);
    err.conflictType = "availability";
    throw err;
  }
}

// Teacher conflict = same teacher already booked (as main or substitute) in an
// overlapping window on the same date with status scheduled or live.
export async function assertNoConflict({ teacher, date, startTime, endTime, ignoreSessionId = null }) {
  const [day, next] = dayBounds(date);
  const sessions = await ClassSession.find({
    _id: ignoreSessionId ? { $ne: ignoreSessionId } : undefined,
    date: { $gte: day, $lt: next },
    status: { $in: ["scheduled", "live"] },
    $or: [{ teacher }, { substituteTeacher: teacher }],
  })
    .select("startTime endTime classGroup")
    .lean();
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  for (const s of sessions) {
    if (start < toMinutes(s.endTime) && end > toMinutes(s.startTime)) {
      const err = new Error("Schedule conflict: this teacher already has an overlapping class on this date");
      err.conflictWith = s._id;
      err.conflictType = "teacher";
      throw err;
    }
  }
}

export async function updateSession(id, updates = {}) {
  const session = await ClassSession.findById(id);
  if (!session) throw new Error("Session not found");

  const becameCancelled = updates.status === "cancelled" && session.status !== "cancelled";

  if (updates.status !== undefined) {
    if (!["scheduled", "live", "completed", "cancelled"].includes(updates.status)) {
      throw new Error("Invalid status");
    }
    session.status = updates.status;
  }
  if (updates.meetingLink !== undefined) session.meetingLink = updates.meetingLink;
  if (updates.notes !== undefined) session.notes = updates.notes;

  const timeChanged =
    (updates.startTime !== undefined && updates.startTime !== session.startTime) ||
    (updates.endTime !== undefined && updates.endTime !== session.endTime) ||
    (updates.date !== undefined && new Date(updates.date).getTime() !== new Date(session.date).getTime());
  if (updates.startTime !== undefined) session.startTime = updates.startTime;
  if (updates.endTime !== undefined) session.endTime = updates.endTime;
  if (updates.date !== undefined) session.date = new Date(updates.date);

  if (updates.substituteTeacher !== undefined) {
    if (updates.substituteTeacher === null || updates.substituteTeacher === "") {
      session.substituteTeacher = null;
    } else {
      const sub = await Teacher.findById(updates.substituteTeacher).select("_id").lean();
      if (!sub) throw new Error("Substitute teacher not found");
      session.substituteTeacher = updates.substituteTeacher;
      // Substitute applies ONLY to this session; ClassGroup.teacher is untouched.
      await assertNoConflict({
        teacher: updates.substituteTeacher,
        date: session.date,
        startTime: session.startTime,
        endTime: session.endTime,
        ignoreSessionId: session._id,
      });
      await assertAvailability({
        teacher: updates.substituteTeacher,
        date: session.date,
        startTime: session.startTime,
        endTime: session.endTime,
      });
      emitToTeacher(updates.substituteTeacher, "class:upcoming", {
        sessionId: session._id,
        role: "substitute",
      });
    }
  }

  if (updates.teacher !== undefined && updates.teacher && String(updates.teacher) !== String(session.teacher)) {
    await assertNoConflict({
      teacher: updates.teacher,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      ignoreSessionId: session._id,
    });
    await assertAvailability({
      teacher: updates.teacher,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
    });
    session.teacher = updates.teacher;
  }

  if (timeChanged) {
    await assertNoDuplicate({
      classGroup: session.classGroup,
      date: session.date,
      startTime: session.startTime,
      ignoreSessionId: session._id,
    });
    await assertNoConflict({
      teacher: session.substituteTeacher || session.teacher,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      ignoreSessionId: session._id,
    });
  }

await session.save();
  emitToQaos("schedule:updated", { sessionId: session._id, status: session.status });
  emitToQaos("class:updated", { sessionId: session._id, status: session.status });
  await logQaoAction({
    action: "SESSION_UPDATED",
    resource: "ClassSession",
    resourceId: session._id,
    details: { status: session.status, teacher: String(session.teacher), substitute: session.substituteTeacher ? String(session.substituteTeacher) : null, startTime: session.startTime, endTime: session.endTime },
  });
  if (becameCancelled) {
    emitToQaos("class:cancelled", { sessionId: session._id });
    emitToTeacher(session.teacher, "class:cancelled", { sessionId: session._id });
  }
  return ClassSession.findById(session._id)
    .populate("teacher", SAFE_TEACHER_FIELDS)
    .populate("substituteTeacher", SAFE_TEACHER_FIELDS)
    .populate("classGroup", SAFE_GROUP_FIELDS)
    .lean();
}

export async function deleteSession(id) {
  const session = await ClassSession.findById(id);
  if (!session) throw new Error("Session not found");
const wasActive = ["scheduled", "live"].includes(session.status);
  await session.deleteOne();
  if (wasActive) emitToQaos("class:cancelled", { sessionId: id });
  await logQaoAction({
    action: "SESSION_DELETED",
    resource: "ClassSession",
    resourceId: id,
    details: { wasActive, teacher: String(session.teacher), status: session.status },
  });
  return { ok: true, deleted: id };
}
// ---------------------------------------------------------------------------
// Virtual classroom helpers
// ---------------------------------------------------------------------------

/**
 * Regenerate the Google Meet meeting for an existing session. Used when the
 * original generation was left pending/failed or when an admin/QM explicitly
 * wants a fresh meeting. Graceful: never throws, always leaves the session in a
 * consistent meetingStatus.
 */
export async function regenerateMeeting(id, { actor = null } = {}) {
  const session = await ClassSession.findById(id);
  if (!session) throw new Error("Session not found");

  const populated = await ClassSession.findById(id)
    .populate("classGroup", "code subject grade curriculum meetingLink")
    .populate("teacher", "fullName")
    .lean();

  const group = populated.classGroup || {};
  const teacherDoc = populated.teacher || {};
  const meeting = await createMeeting({
    subject: group.subject || "",
    grade: group.grade || "",
    teacherName: teacherDoc.fullName || "",
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
    sessionId: id,
    rollNumber: group.code || "",
  });

  if (meeting.meetingLink) {
    session.meetingLink = meeting.meetingLink;
    session.meetingCode = meeting.meetingCode || "";
    session.conferenceId = meeting.conferenceId || "";
    session.calendarEventId = meeting.calendarEventId || "";
    session.meetingStatus = meeting.meetingStatus || "pending";
  } else {
    session.meetingStatus = "failed";
  }
  await session.save();

  emitToQaos("meeting:updated", { sessionId: id, meetingStatus: session.meetingStatus, meetingLink: session.meetingLink });
  emitToAdmin("meeting:updated", { sessionId: id, meetingStatus: session.meetingStatus });
  emitToTeacher(session.teacher, "meeting:updated", { sessionId: id, meetingStatus: session.meetingStatus });

  try {
    await syncClassSession(session, {
      action: session.meetingStatus === "ready" ? CLASS_SYNC_ACTIONS.MEETING_READY : CLASS_SYNC_ACTIONS.UPDATED,
    });
  } catch { /* display sync must never break scheduling */ }

  await logQaoAction({
    action: "MEETING_REGENERATED",
    resource: "ClassSession",
    resourceId: id,
    details: {
      meetingStatus: session.meetingStatus,
      meetingProvider: session.meetingProvider,
      actor: actor ? String(actor) : null,
    },
  });

  return ClassSession.findById(id)
    .populate("teacher", SAFE_TEACHER_FIELDS)
    .populate("substituteTeacher", SAFE_TEACHER_FIELDS)
    .populate("classGroup", SAFE_GROUP_FIELDS)
    .lean();
}
/**
 * Replace the teacher on a session, honouring an override when the replacement
 * would otherwise conflict. REQUIRES a reason for the override (audit proof).
 */
export async function replaceSessionTeacher(id, { teacher, reason = null, override = false, actor = null } = {}) {
  const session = await ClassSession.findById(id);
  if (!session) throw new Error("Session not found");
  if (!teacher) throw new Error("Teacher is required");

  const isOverride = override === true || override === "true";
  if (isOverride && !(reason && String(reason).trim())) {
    throw new Error("reason is required when overriding a schedule");
  }

  const sub = await Teacher.findById(teacher).select("_id fullName").lean();
  if (!sub) throw new Error("Teacher not found");

  if (!isOverride) {
    await assertNoConflict({
      teacher,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      ignoreSessionId: session._id,
    });
    await assertAvailability({ teacher, date: session.date, startTime: session.startTime, endTime: session.endTime });
  }

  const previousTeacher = String(session.teacher);
  const wasSubstitute = String(session.substituteTeacher || "") === String(teacher);
  if (wasSubstitute) {
    session.substituteTeacher = null;
  } else {
    session.teacher = teacher;
  }
  await session.save();

  emitToTeacher(teacher, "class:upcoming", { sessionId: session._id, role: "replacement" });
  emitToQaos("teacher:replaced", { sessionId: session._id, previousTeacher, newTeacher: String(teacher), override: isOverride });
  emitToAdmin("teacher:replaced", { sessionId: session._id, override: isOverride });
  if (isOverride) {
    await logQaoAction({
      action: "schedule.override",
      resource: "ClassSession",
      resourceId: session._id,
      details: {
        reason: String(reason).trim(),
        overridden: { previousTeacher, newTeacher: String(teacher), override: true },
      },
    });
  }

  return ClassSession.findById(session._id)
    .populate("teacher", SAFE_TEACHER_FIELDS)
    .populate("substituteTeacher", SAFE_TEACHER_FIELDS)
    .populate("classGroup", SAFE_GROUP_FIELDS)
    .lean();
}

/**
 * Append or update a student attendance record for a session. When leftAt is
 * provided the minutes are (re)computed. source = client | teacher | qao.
 */
export async function recordAttendance(id, { student, joinedAt, leftAt = null, source = "client" }) {
  const session = await ClassSession.findById(id);
  if (!session) throw new Error("Session not found");
  if (!student) throw new Error("Student is required");

  const joined = joinedAt ? new Date(joinedAt) : new Date();
  const left = leftAt ? new Date(leftAt) : null;
  const existing = session.attendance.find((a) => String(a.student) === String(student));

  if (existing) {
    existing.joinedAt = joined;
    if (left) existing.leftAt = left;
    if (source && ["client", "teacher", "qao"].includes(source)) existing.source = source;
  } else {
    session.attendance.push({ student, joinedAt: joined, leftAt: left, source });
  }

  // Recompute duration whenever we have both endpoints.
  for (const a of session.attendance) {
    if (a.joinedAt && a.leftAt) {
      const ms = new Date(a.leftAt).getTime() - new Date(a.joinedAt).getTime();
      a.duration = ms > 0 ? Math.round((ms / 60000) * 10) / 10 : 0;
    }
  }

  const current = session.attendance.find((a) => String(a.student) === String(student));
  // Attendance events (rooms only): joined on first record, left once leftAt set.
  const attEvent = left ? "attendance:left" : "attendance:joined";
  emitToTeacher(session.substituteTeacher || session.teacher, attEvent, { sessionId: session._id, studentCount: session.attendance.length });
  emitToQaos(attEvent, { sessionId: session._id, studentCount: session.attendance.length });
  await session.save();
  return { student: String(student), joinedAt: joined, leftAt: left, duration: current?.duration || 0 };
}

/** Return the attendance array for a session (for teacher/QAO/admin dashboards). */
export async function listAttendance(id) {
  const session = await ClassSession.findById(id).populate("attendance.student", "fullName userId email").lean();
  if (!session) throw new Error("Session not found");
  return session.attendance || [];
}
/**
 * End a class (teacher "End Class" / admin force-end). Marks the session
 * completed, emits class:ended to all relevant rooms, syncs Moodle and audits.
 */
export async function endSession(id, { actor = null, forced = false } = {}) {
  const session = await ClassSession.findById(id);
  if (!session) throw new Error("Session not found");
  if (session.status === "cancelled") throw new Error("This class is cancelled and cannot be ended");

  session.status = "completed";
  await session.save();

  const payload = { sessionId: session._id, forced };
  emitToQaos("class:ended", payload);
  emitToTeacher(session.substituteTeacher || session.teacher, "class:ended", payload);
  emitToAdmin("class:ended", payload);
  try {
    const Group = (await import("../ClassGroup.js" )).default;
    const g = await Group.findById(session.classGroup).select("students").lean();
    emitToStudents(g?.students || [], "class:ended", payload);
  } catch { /* non-fatal */ }
  try {
    await syncClassSession(session, { action: CLASS_SYNC_ACTIONS.UPDATED });
  } catch { /* display sync never breaks ending */ }

  await logQaoAction({
    action: forced ? "CLASS_FORCE_ENDED" : "CLASS_ENDED",
    resource: "ClassSession",
    resourceId: session._id,
    details: { actor: actor ? String(actor) : null, forced },
  });
  return ClassSession.findById(id).populate("teacher", SAFE_TEACHER_FIELDS).populate("classGroup", SAFE_GROUP_FIELDS).lean();
}
