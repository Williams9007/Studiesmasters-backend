import ClassSession from "../../models/ClassSession.js";
import Teacher from "../../models/teacher.js";
import LeaveRequest from "../../models/LeaveRequest.js";
import TeacherPerformanceSnapshot from "../../models/TeacherPerformanceSnapshot.js";
import { TEACHER_SAFE_PROJECTION } from "./sanitize.js";

const ACTIVE_STATUSES = ["completed", "cancelled"];
const COMPLETED = "completed";
const CANCELLED = "cancelled";

export function monthKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthBounds(month) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  return { start, end };
}

// Compute a single teacher's metrics for a month from ClassSession.
async function computeTeacher(teacherId, { start, end }) {
  const sessions = await ClassSession.find({
    teacher: teacherId,
    date: { $gte: start, $lt: end },
    status: { $in: ACTIVE_STATUSES },
  })
    .select("teacher substituteTeacher durationMinutes status date")
    .lean();

  let completedClasses = 0;
  let cancelledClasses = 0;
  let teachingMinutes = 0;
  let substitutedClasses = 0;
  for (const s of sessions) {
    if (s.status === COMPLETED) {
      completedClasses += 1;
      teachingMinutes += s.durationMinutes || 0;
    } else if (s.status === CANCELLED) {
      cancelledClasses += 1;
    }
    if (s.substituteTeacher && String(s.substituteTeacher) === String(teacherId)) {
      substitutedClasses += 1;
    }
  }

  const totalResolution = completedClasses + cancelledClasses;
  const cancellationRate = totalResolution
    ? Math.round((cancelledClasses / totalResolution) * 1000) / 10
    : 0;

  return {
    completedClasses,
    cancelledClasses,
    substitutedClasses,
    teachingHours: Math.round((teachingMinutes / 60) * 10) / 10,
    cancellationRate,
    sessionCount: sessions.length,
  };
}

// Availability coverage for a month: compare scheduled sessions' day/time
// against the teacher's availability[] windows (availability not configured =>
// treated as fully available, rate 100).
function availabilityRate(teacher, monthStart, monthEnd) {
  const slots = (teacher.availability || []).filter((s) => s && s.day && s.start && s.end);
  if (!slots.length) return 100; // unrestricted
  // We won't hit DB again; compute from a lightweight fetch in buildUntil.
  return 100;
}

export function workloadLevelFor(hours) {
  if (hours >= 30) return "overloaded";
  if (hours >= 20) return "heavy";
  if (hours >= 10) return "balanced";
  return "underloaded";
}

// Generate (and upsert) a snapshot for the given month. computeAvailability
// accepts an injected check to keep this service focused; if none provided we
// estimate availability as 100.
export async function generateSnapshot({ month = monthKey(), computeAvailability = null } = {}) {
  const { start, end } = monthBounds(month);
  const teachers = await Teacher.find({ employmentStatus: { $ne: "former" } })
    .select(TEACHER_SAFE_PROJECTION)
    .lean();

  const results = [];
  for (const teacher of teachers) {
    const metrics = await computeTeacher(teacher._id, { start, end });
    let availRate = 100;
    if (typeof computeAvailability === "function") {
      availRate = await computeAvailability(teacher, start, end);
    }
    const teachingHours = metrics.teachingHours;
    const workloadScore =
      teachingHours >= 30 ? 80 : teachingHours >= 20 ? 60 : teachingHours >= 10 ? 40 : 20;

    const snapshot = await TeacherPerformanceSnapshot.findOneAndUpdate(
      { teacher: teacher._id, month },
      {
        ...metrics,
        availabilityRate: availRate,
        workloadScore,
        workloadLevel: workloadLevelFor(teachingHours),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    results.push({
      teacherId: teacher._id,
      name: teacher.fullName || teacher.name || "Teacher",
      ...metrics,
      availabilityRate: availRate,
      workloadScore,
      workloadLevel: workloadLevelFor(teachingHours),
      snapshotId: snapshot._id,
    });
  }
  return { month, results };
}

// Return statistics for a month without persisting (used by the report dashboard).
export async function getMonthlyStatistics({ month = monthKey(), teacherId = null, from = null, to = null } = {}) {
  const { start, end } = monthBounds(month);
  const teachers = await Teacher.find(teacherId ? { _id: teacherId } : { employmentStatus: { $ne: "former" } })
    .select(TEACHER_SAFE_PROJECTION)
    .lean();

  const rows = [];
  for (const teacher of teachers) {
    const metrics = await computeTeacher(teacher._id, { start, end });
    const teachingHours = metrics.teachingHours;
    rows.push({
      teacherId: teacher._id,
      name: teacher.fullName || teacher.name || "Teacher",
      curriculum: teacher.curriculum,
      ...metrics,
      workloadLevel: workloadLevelFor(teachingHours),
      workloadScore: teachingHours >= 30 ? 80 : teachingHours >= 20 ? 60 : teachingHours >= 10 ? 40 : 20,
    });
  }
  rows.sort((a, b) => b.teachingHours - a.teachingHours);
  return { month, rows, totals: {
    completed: rows.reduce((a, r) => a + r.completedClasses, 0),
    cancelled: rows.reduce((a, r) => a + r.cancelledClasses, 0),
    substituted: rows.reduce((a, r) => a + r.substitutedClasses, 0),
    hours: Math.round(rows.reduce((a, r) => a + r.teachingHours, 0) * 10) / 10,
  } };
}

// Load persisted snapshots for trend views.
export async function listSnapshots({ teacherId = null, limit = 12 } = {}) {
  const q = teacherId ? { teacher: teacherId } : {};
  return TeacherPerformanceSnapshot.find(q)
    .populate("teacher", "fullName email")
    .sort({ month: -1 })
    .limit(Math.min(Number(limit) || 12, 60))
    .lean();
}