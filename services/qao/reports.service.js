import ClassSession from "../../models/ClassSession.js";
import ClassGroup from "../../models/ClassGroup.js";

export async function getReports({ from, to } = {}) {
  const match = {};
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lt = new Date(to);
  }

  const [workload, curriculumDistribution, weeklyActivity] = await Promise.all([
    // Teacher workload: sessions and minutes by teacher/status
    ClassSession.aggregate([
      { $match: match },
      {
        $group: {
          _id: { teacher: "$teacher", status: "$status" },
          sessions: { $sum: 1 },
          minutes: { $sum: "$durationMinutes" },
        },
      },
      {
        $group: {
          _id: "$_id.teacher",
          byStatus: { $push: { status: "$_id.status", sessions: "$sessions", minutes: "$minutes" } },
          totalSessions: { $sum: "$sessions" },
          totalMinutes: { $sum: "$minutes" },
        },
      },
      { $sort: { totalSessions: -1 } },
    ]),

    // Curriculum distribution from ClassGroup (no student data involved)
    ClassGroup.aggregate([
      { $group: { _id: "$curriculum", groups: { $sum: 1 }, capacity: { $sum: "$capacity" } } },
      { $sort: { groups: -1 } },
    ]),

    // Weekly activity for the last 7 days
    ClassSession.aggregate([
      {
        $match: {
          date: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          scheduled: { $sum: { $cond: [{ $eq: ["$status", "scheduled"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const statusTotal = (status) =>
    workload.reduce(
      (acc, w) => acc + (w.byStatus.find((s) => s.status === status)?.sessions || 0),
      0
    );

  return {
    workload: workload.map((w) => ({
      teacherId: w._id,
      totalSessions: w.totalSessions,
      teachingHours: Math.round((w.totalMinutes / 60) * 10) / 10,
      byStatus: w.byStatus,
    })),
    totals: { completed: statusTotal("completed"), cancelled: statusTotal("cancelled") },
    curriculumDistribution,
    weeklyActivity,
  };
}
/**
 * Virtual classroom analytics for the QAO/Admin dashboards and reports.
 * Operates only on ClassSession + ClassGroup — no student PII is returned
 * (attendance is aggregated to counts, never individual records).
 */
export async function getVirtualClassMetrics({ from, to } = {}) {
  const match = {};
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lt = new Date(to);
  }

  const [summary, attendanceAgg, meetingAgg] = await Promise.all([
    // Top-level counts by status + meeting state.
    ClassSession.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          sessions: { $sum: 1 },
          // Count sessions that carry a meeting provider field = "google-meet".
          withMeeting: {
            $sum: { $cond: [{ $eq: ["$meetingProvider", "google-meet"] }, 1, 0] },
          },
        },
      },
    ]),

    // Attendance aggregate (duration minutes per student across sessions).
    // We unwind attendance but only keep document-level status gates.
    ClassSession.aggregate([
      { $match: { ...match, "attendance.0": { $exists: true } } },
      { $unwind: "$attendance" },
      {
        $group: {
          _id: null,
          joinedCount: { $sum: 1 },
          totalDurationMin: { $sum: { $ifNull: ["$attendance.duration", 0] } },
        },
      },
    ]),

    // Meeting generation success rate (ready vs pending/failed).
    ClassSession.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$meetingStatus",
          sessions: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byStatus = {};
  let total = 0;
  for (const r of summary) {
    byStatus[r._id || "unknown"] = r.sessions;
    total += r.sessions;
  }

  const meetingByStatus = {};
  for (const r of meetingAgg) meetingByStatus[r._id || "unknown"] = r.sessions;

  const att = attendanceAgg[0];
  const done = byStatus.completed || 0;
  const attempted = done + (byStatus.cancelled || 0) + (byStatus.scheduled || 0) + (byStatus.live || 0);

  return {
    totalVirtualClasses: total,
    byStatus,
    completed: byStatus.completed || 0,
    cancelled: byStatus.cancelled || 0,
    live: byStatus.live || 0,
    upcoming: byStatus.scheduled || 0,
    // Meeting status is qao-safe: just a state string.
    meeting: {
      ready: meetingByStatus.ready || 0,
      pending: meetingByStatus.pending || 0,
      failed: meetingByStatus.failed || 0,
      generationSuccessRate: total
        ? Math.round(((meetingByStatus.ready || 0) / total) * 1000) / 10
        : 0,
    },
    // Attendance aggregates (no individual student data).
    attendance: {
      studentsJoined: att?.joinedCount || 0,
      totalDurationMinutes: Math.round((att?.totalDurationMin || 0) * 10) / 10,
      averageDurationMinutes: att?.joinedCount
        ? Math.round(((att.totalDurationMin / att.joinedCount) * 10)) / 10
        : 0,
      attendanceRate: attempted
        ? Math.round(((done / attempted) * 1000)) / 10
        : 0,
    },
  };
}
/**
 * Deep virtual-classroom analytics (Phase 6H). Aggregates only — when
 * `includeStudents` is true (ADMIN surface only) per-student activity names are
 * included; the QAO surface must pass false to keep student PII out.
 */
export async function getVirtualAnalytics({ from, to, includeStudents = false } = {}) {
  const match = {};
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lt = new Date(to);
  }

  const [byStatus, meetingAgg, punctuality, activity] = await Promise.all([
    ClassSession.aggregate([
      { $match: match },
      { $group: { _id: "$status", sessions: { $sum: 1 } } },
    ]),
    ClassSession.aggregate([
      { $match: match },
      { $group: { _id: "$meetingStatus", sessions: { $sum: 1 } } },
    ]),
    // Teacher punctuality: of completed sessions, how many went live (i.e. the
    // teacher started) vs stayed scheduled. Uses status history proxy: live or
    // completed implies started.
    ClassSession.aggregate([
      { $match: { ...match, status: { $in: ["live", "completed"] } } },
      {
        $group: {
          _id: "$teacher",
          started: { $sum: 1 },
          sessionsWithAttendance: {
            $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$attendance", []] } }, 0] }, 1, 0] },
          },
        },
      },
    ]),
    // Most active classes (by group).
    ClassSession.aggregate([
      { $match: match },
      { $group: { _id: "$classGroup", sessions: { $sum: 1 } } },
      { $sort: { sessions: -1 } },
      { $limit: 10 },
    ]),
  ]);

  // Attendance aggregates across all sessions.
  const attAgg = await ClassSession.aggregate([
    { $match: { ...match, "attendance.0": { $exists: true } } },
    { $unwind: "$attendance" },
    {
      $group: {
        _id: null,
        joins: { $sum: 1 },
        withLeft: { $sum: { $cond: [{ $ne: ["$attendance.leftAt", null] }, 1, 0] } },
        totalDurationMin: { $sum: { $ifNull: ["$attendance.duration", 0] } },
      },
    },
  ]);

  // Late rate: students whose joinedAt is after the session start.
  const lateAgg = await ClassSession.aggregate([
    { $match: { ...match, "attendance.0": { $exists: true } } },
    { $unwind: "$attendance" },
    {
      $project: {
        late: {
          $gt: [
            { $subtract: ["$attendance.joinedAt", { $dateFromString: { dateString: { $concat: [{ $dateToString: { format: "%Y-%m-%d", date: "$date" } }, "T", { $concat: ["$startTime", ":00"] }] } } }] },
            5 * 60 * 1000, // > 5 min after start = late
          ],
        },
      },
    },
    { $group: { _id: null, late: { $sum: { $cond: ["$late", 1, 0] } }, total: { $sum: 1 } } },
  ]);

  const statusMap = Object.fromEntries(byStatus.map((r) => [r._id || "unknown", r.sessions]));
  const meetingMap = Object.fromEntries(meetingAgg.map((r) => [r._id || "unknown", r.sessions]));
  const total = byStatus.reduce((a, r) => a + r.sessions, 0);
  const started = punctuality.reduce((a, r) => a + r.started, 0);
  const att = attAgg[0] || { joins: 0, withLeft: 0, totalDurationMin: 0 };
  const late = lateAgg[0] || { late: 0, total: 0 };

  const out = {
    totals: {
      classes: total,
      completed: statusMap.completed || 0,
      cancelled: statusMap.cancelled || 0,
      live: statusMap.live || 0,
      scheduled: statusMap.scheduled || 0,
    },
    meeting: {
      ready: meetingMap.ready || 0,
      pending: meetingMap.pending || 0,
      failed: meetingMap.failed || 0,
      successRate: total ? Math.round(((meetingMap.ready || 0) / total) * 1000) / 10 : 0,
    },
    attendance: {
      joins: att.joins,
      completedLeaves: att.withLeft,
      avgDurationMinutes: att.joins ? Math.round((att.totalDurationMin / att.joins) * 10) / 10 : 0,
      joinRate: started ? Math.round((att.joins / started) * 1000) / 10 : 0,
      lateRate: late.total ? Math.round((late.late / late.total) * 1000) / 10 : 0,
      lateJoins: late.late,
    },
    teacherPunctuality: punctuality.map((p) => ({
      teacherId: p._id,
      started: p.started,
      sessionsWithAttendance: p.sessionsWithAttendance,
    })),
    mostActiveClasses: activity,
  };

  // Admin-only: most active students (identifiable). QAO must NOT see names.
  if (includeStudents) {
    const studentsAgg = await ClassSession.aggregate([
      { $match: { ...match, "attendance.0": { $exists: true } } },
      { $unwind: "$attendance" },
      {
        $group: {
          _id: "$attendance.student",
          joins: { $sum: 1 },
          minutes: { $sum: { $ifNull: ["$attendance.duration", 0] } },
        },
      },
      { $sort: { joins: -1 } },
      { $limit: 10 },
    ]);
    const Student = (await import("../../models/Student.js")).default;
    const ids = studentsAgg.map((s) => s._id).filter(Boolean);
    const docs = await Student.find({ _id: { $in: ids } }).select("fullName userId").lean();
    const nameById = Object.fromEntries(docs.map((d) => [String(d._id), { name: d.fullName, userId: d.userId }]));
    out.mostActiveStudents = studentsAgg.map((s) => ({
      studentId: s._id,
      name: nameById[String(s._id)]?.name || "Unknown",
      userId: nameById[String(s._id)]?.userId || "",
      joins: s.joins,
      minutes: Math.round(s.minutes * 10) / 10,
    }));
  }

  return out;
}
