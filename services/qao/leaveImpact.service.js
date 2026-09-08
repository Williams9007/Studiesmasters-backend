import ClassSession from "../../models/ClassSession.js";
import * as teacherMatching from "./teacherMatching.service.js";

const SAFE_TEACHER_FIELDS = "fullName email employeeRole employmentStatus photo";
const SAFE_GROUP_FIELDS = "code curriculum grade subject capacity status schedule meetingLink";

// Leave impact analysis: given an approved leave, find the affected active
// sessions, compute affected teaching hours, and suggest substitutes per
// session (recommendations only - the Tutor Manager confirms assignments).
export async function findAffectedSessions(leave) {
  const start = new Date(leave.startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(leave.endDate);
  end.setHours(23, 59, 59, 999);

  const sessions = await ClassSession.find({
    teacher: leave.teacher,
    date: { $gte: start, $lte: end },
    status: { $in: ["scheduled", "live"] },
  })
    .populate("teacher", SAFE_TEACHER_FIELDS)
    .populate("classGroup", SAFE_GROUP_FIELDS)
    .sort({ date: 1, startTime: 1 })
    .lean();

  let totalMinutes = 0;
  const affected = [];
  for (const session of sessions) {
    if (session.substituteTeacher) continue; // already covered
    totalMinutes += session.durationMinutes || 0;
    const suggestedSubstitutes = await teacherMatching.suggestForSession(session);
    affected.push({ ...session, suggestedSubstitutes });
  }

  return {
    affectedSessions: affected,
    affectedCount: affected.length,
    affectedHours: Math.round((totalMinutes / 60) * 10) / 10,
  };
}

