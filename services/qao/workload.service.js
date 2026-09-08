import ClassSession from "../../models/ClassSession.js";
import Teacher from "../../models/teacher.js";
import { TEACHER_SAFE_PROJECTION } from "./sanitize.js";
import { emitToQaos } from "./notify.js";

// Configurable workload thresholds (hours per week). Override via env:
// WORKLOAD_UNDERLOADED, WORKLOAD_BALANCED, WORKLOAD_HEAVY
export const WORKLOAD_THRESHOLDS = {
  underloaded: Number(process.env.WORKLOAD_UNDERLOADED) || 10,
  balanced: Number(process.env.WORKLOAD_BALANCED) || 20,
  heavy: Number(process.env.WORKLOAD_HEAVY) || 30,
};

export function statusForHours(hours) {
  if (hours >= WORKLOAD_THRESHOLDS.heavy) return "overloaded";
  if (hours >= WORKLOAD_THRESHOLDS.balanced) return "heavy";
  if (hours >= WORKLOAD_THRESHOLDS.underloaded) return "balanced";
  return "underloaded";
}

// Rolling-week hours per teacher: sessions in [now-7d, now+1d) with status
// scheduled | live | completed. Cancelled sessions do not count.
export async function weeklyHours() {
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const to = new Date();
  to.setDate(to.getDate() + 1);
  const rows = await ClassSession.aggregate([
    {
      $match: {
        date: { $gte: from, $lt: to },
        status: { $in: ["scheduled", "live", "completed"] },
      },
    },
    {
      $group: {
        _id: "$teacher",
        minutes: { $sum: "$durationMinutes" },
        sessions: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        cancelled: { $sum: 0 },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) {
    map.set(String(r._id), {
      hours: Math.round((r.minutes / 60) * 10) / 10,
      sessions: r.sessions,
      completed: r.completed,
    });
  }
  return map;
}

export async function getWorkload() {
  const [hoursMap, teachers] = await Promise.all([
    weeklyHours(),
    Teacher.find({ employmentStatus: { $ne: "former" } })
      .select(TEACHER_SAFE_PROJECTION)
      .populate("subjectsTeaching", "name curriculum grade")
      .lean(),
  ]);
  return teachers.map((t) => {
    const h = hoursMap.get(String(t._id)) || { hours: 0, sessions: 0, completed: 0 };
    return {
      teacherId: t._id,
      name: t.fullName || t.name || "Teacher",
      email: t.email,
      employmentStatus: t.employmentStatus,
      subjects: (t.subjectsTeaching || []).map((s) => s.name),
      hours: h.hours,
      sessions: h.sessions,
      completed: h.completed,
      status: statusForHours(h.hours),
    };
  });
}

// Called after scheduling changes: emits teacher:overloaded once per crossing.
const overloadedNotified = new Set();
export async function checkOverloaded(teacherId) {
  const map = await weeklyHours();
  const h = map.get(String(teacherId));
  const hours = h ? h.hours : 0;
  const status = statusForHours(hours);
  if ((status === "overloaded" || status === "heavy") && !overloadedNotified.has(String(teacherId))) {
    overloadedNotified.add(String(teacherId));
    emitToQaos("teacher:overloaded", { teacherId, hours, status });
  } else if (status === "underloaded" || status === "balanced") {
    overloadedNotified.delete(String(teacherId));
  }
  return { hours, status };
}
