import Teacher from "../../models/teacher.js";
import { TEACHER_SAFE_PROJECTION, sanitizeTeacher } from "./sanitize.js";

export async function listTeachers(filter = {}) {
  const teachers = await Teacher.find(filter)
    .select(TEACHER_SAFE_PROJECTION)
    .populate("subjectsTeaching", "name curriculum grade")
    .sort({ fullName: 1, name: 1 })
    .lean();
  return teachers.map(sanitizeTeacher);
}

export async function getTeacherById(id) {
  const teacher = await Teacher.findById(id)
    .select(TEACHER_SAFE_PROJECTION)
    .populate("subjectsTeaching", "name curriculum grade")
    .lean();
  if (!teacher) throw new Error("Teacher not found");
  return sanitizeTeacher(teacher);
}

const ALLOWED_TEACHER_UPDATES = [
  "photo",
  "qualifications",
  "employmentStatus",
  "internalNotes",
  "phone",
];

export async function updateTeacher(id, updates = {}) {
  const payload = {};
  for (const key of ALLOWED_TEACHER_UPDATES) {
    if (updates[key] !== undefined) payload[key] = updates[key];
  }
  if (!Object.keys(payload).length) throw new Error("No valid fields to update");
  const teacher = await Teacher.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true,
  }).select(TEACHER_SAFE_PROJECTION);
  if (!teacher) throw new Error("Teacher not found");
  return sanitizeTeacher(teacher);
}
