import Teacher from "../../models/teacher.js";
import ClassGroup from "../../models/ClassGroup.js";
import Timetable from "../../models/Timetable.js";
import Resource from "../../models/Resource.js";
import Broadcast from "../../models/Broadcast.js";
import ClassSession from "../../models/ClassSession.js";
import LeaveRequest from "../../models/LeaveRequest.js";
import { statusForHours, weeklyHours } from "./workload.service.js";

export async function getOverview() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const [
    totalTeachers,
    activeTeachers,
    totalGroups,
    activeGroups,
    unassignedGroups,
    pendingTimetables,
    pendingResources,
    broadcastCount,
    classesToday,
    pendingLeaveRequests,
    availableToday,
    overloadedTeachers,
    sessionsNeedingSubstitute,
  ] = await Promise.all([
    Teacher.countDocuments({}),
    Teacher.countDocuments({ employmentStatus: "active" }),
    ClassGroup.countDocuments({}),
    ClassGroup.countDocuments({ status: "active" }),
    ClassGroup.countDocuments({ $or: [{ teacher: null }, { teacher: { $exists: false } }] }),
    Timetable.countDocuments({ status: "Pending" }),
    Resource.countDocuments({ approved: false }),
    Broadcast.countDocuments({}),
    ClassSession.countDocuments({
      date: { $gte: startOfToday, $lt: endOfToday },
      status: { $in: ["scheduled", "live"] },
    }),
  ]);

  return {
    teachers: { total: totalTeachers, active: activeTeachers },
    classGroups: { total: totalGroups, active: activeGroups, unassigned: unassignedGroups },
    pendingTimetables,
    pendingResources,
    broadcasts: broadcastCount,
    classesToday,
    pendingLeaveRequests,
    availableToday,
    overloadedTeachers,
    sessionsNeedingSubstitute,
  };
}

