import Teacher from "../../models/teacher.js";
import ClassGroup from "../../models/ClassGroup.js";
import { TEACHER_SAFE_PROJECTION, sanitizeTeacher } from "./sanitize.js";
import { getWorkload } from "./workload.service.js";

// Weighted matching score (total 100):
//   subject match 40 | curriculum match 25 | grade match 15 | availability 10 | workload 10
function coversAvailability(teacher, date, startTime, endTime) {
  const slots = (teacher.availability || []).filter((s) => s && s.day && s.start && s.end);
  if (!slots.length) return "unknown"; // no availability configured
  const day = new Date(date).toLocaleDateString("en-US", { weekday: "long" });
  const toMin = (t) => {
    const [h, m] = String(t).split(":").map(Number);
    return h * 60 + (m || 0);
  };
  return slots.some(
    (s) => String(s.day).toLowerCase() === day.toLowerCase() &&
      toMin(startTime) >= toMin(s.start) && toMin(endTime) <= toMin(s.end)
  )
    ? "covered"
    : "not_covered";
}

function scoreTeacher(teacher, { subject, curriculum, grade, date, startTime, endTime }, hours = 0) {
  const subjects = (teacher.subjectsTeaching || []).map((s) => s);
  const subjectNames = subjects.map((s) => String(s.name || s).toLowerCase());
  const grades = subjects.map((s) => String(s.grade || "").toLowerCase());
  const breakdown = { subject: 0, curriculum: 0, grade: 0, availability: 0, workload: 0 };

  if (subject && subjectNames.includes(String(subject).toLowerCase())) breakdown.subject = 40;
  if (curriculum && String(teacher.curriculum || "").toLowerCase() === String(curriculum).toLowerCase()) breakdown.curriculum = 25;
  if (grade && grades.includes(String(grade).toLowerCase())) breakdown.grade = 15;
  const avail = coversAvailability(teacher, date, startTime, endTime);
  breakdown.availability = avail === "covered" ? 10 : avail === "unknown" ? 5 : 0;
  breakdown.workload = Math.max(0, 10 - Math.min(10, hours / 3));

  const score = Math.round(breakdown.subject + breakdown.curriculum + breakdown.grade + breakdown.availability + breakdown.workload);
  return { teacher: sanitizeTeacher(teacher), score, breakdown, availability: avail, weeklyHours: hours };
}

async function loadTeachersWithSubjects() {
  return Teacher.find({ employmentStatus: { $ne: "former" } })
    .select(TEACHER_SAFE_PROJECTION)
    .populate("subjectsTeaching", "name curriculum grade")
    .lean();
}

export async function suggestForGroup(classGroupId, { date, startTime, endTime } = {}) {
  const group = await ClassGroup.findById(classGroupId).lean();
  if (!group) throw new Error("Class group not found");
  const [teachers, workload] = await Promise.all([loadTeachersWithSubjects(), getWorkload()]);
  const hoursMap = new Map(workload.map((w) => [String(w.teacherId), w.hours]));
  const matches = teachers
    .filter((t) => String(t._id) !== String(group.teacher || ""))
    .map((t) => scoreTeacher(t, { subject: group.subject, curriculum: group.curriculum, grade: group.grade, date, startTime, endTime }, hoursMap.get(String(t._id)) || 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { classGroup: { _id: group._id, code: group.code, subject: group.subject, curriculum: group.curriculum, grade: group.grade }, suggestions: matches };
}

export async function suggestForSession(session) {
  // session should have classGroup populated (or an id) plus date/times
  let group = session.classGroup;
  if (!group || typeof group === "string" || !group.subject) {
    group = await ClassGroup.findById(session.classGroup).lean();
  }
  if (!group) throw new Error("Class group not found");
  const [teachers, workload] = await Promise.all([loadTeachersWithSubjects(), getWorkload()]);
  const hoursMap = new Map(workload.map((w) => [String(w.teacherId), w.hours]));
  const exclude = [String(session.teacher || ""), String(session.substituteTeacher || "")].filter(Boolean);
  return teachers
    .filter((t) => !exclude.includes(String(t._id)))
    .map((t) => scoreTeacher(t, { subject: group.subject, curriculum: group.curriculum, grade: group.grade, date: session.date, startTime: session.startTime, endTime: session.endTime }, hoursMap.get(String(t._id)) || 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
