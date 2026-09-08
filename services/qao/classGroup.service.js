import ClassGroup from "../../models/ClassGroup.js";
import Teacher from "../../models/teacher.js";
import { sanitizeClassGroup } from "./sanitize.js";
import { emitToQaos } from "./notify.js";

// Capacity stays restricted to the package-aligned values used by the
// auto-grouping algorithm (services/classGroupService.js).
const CAPACITIES = [1, 5, 10];

export async function listClassGroups(filter = {}) {
  const groups = await ClassGroup.find(filter)
    .populate("teacher", "fullName email employeeRole employmentStatus photo")
    .sort({ createdAt: -1 })
    .lean();
  return groups.map(sanitizeClassGroup);
}

export async function createClassGroup(data = {}) {
  const { code, curriculum, grade, subject, capacity, teacher, schedule, meetingLink } = data;
  if (!code || !curriculum || !grade || !subject) {
    throw new Error("code, curriculum, grade and subject are required");
  }
  // Accept GES / Cambridge in any common spelling, normalize to canonical form.
  const curriculumNorm = String(curriculum).trim();
  const normalizedCurriculum = /^cambridge$/i.test(curriculumNorm) ? "Cambridge" : /^ges$/i.test(curriculumNorm) ? "GES" : null;
  if (!normalizedCurriculum) {
    throw new Error("Curriculum must be GES or Cambridge");
  }
  if (!CAPACITIES.includes(Number(capacity))) {
    throw new Error("Capacity must be 1, 5, or 10");
  }
  if (teacher && !(await Teacher.findById(teacher).select("_id").lean())) {
    throw new Error("Teacher not found");
  }
  const normalizedCode = String(code).toUpperCase().trim();
  const exists = await ClassGroup.findOne({ code: normalizedCode }).lean();
  if (exists) throw new Error("A class group with this code already exists");

  const group = await ClassGroup.create({
    code: normalizedCode,
    curriculum: normalizedCurriculum,

    grade,
    subject,
    capacity: Number(capacity),
    teacher: teacher || null,
    schedule: {
      day: schedule?.day || "",
      startTime: schedule?.startTime || "",
      endTime: schedule?.endTime || "",
    },
    meetingLink: meetingLink || "",
    status: "active",
  });

  if (!group.teacher) emitToQaos("group:unassigned", { groupId: group._id, code: group.code });
  return sanitizeClassGroup(group);
}

export async function updateClassGroup(id, updates = {}) {
  const group = await ClassGroup.findById(id);
  if (!group) throw new Error("Class group not found");

  const allowed = ["curriculum", "grade", "subject", "status", "schedule", "meetingLink"];
  if (updates.curriculum !== undefined) {
    const cv = String(updates.curriculum).trim();
    const norm = /^cambridge$/i.test(cv) ? "Cambridge" : /^ges$/i.test(cv) ? "GES" : null;
    if (!norm) throw new Error("Curriculum must be GES or Cambridge");
    group.curriculum = norm;
    updates = { ...updates, curriculum: undefined };
  }
  for (const key of allowed) {
    if (updates[key] !== undefined) group[key] = updates[key];
  }
  if (updates.capacity !== undefined) {
    if (!CAPACITIES.includes(Number(updates.capacity))) {
      throw new Error("Capacity must be 1, 5, or 10");
    }
    group.capacity = Number(updates.capacity);
  }
  if (updates.teacher !== undefined) {
    if (updates.teacher === null || updates.teacher === "") {
      group.teacher = null;
    } else {
      const teacher = await Teacher.findById(updates.teacher).select("_id").lean();
      if (!teacher) throw new Error("Teacher not found");
      group.teacher = updates.teacher;
    }
  }
  await group.save();

  if (!group.teacher) emitToQaos("group:unassigned", { groupId: group._id, code: group.code });
  const populated = await ClassGroup.findById(group._id)
    .populate("teacher", "fullName email employeeRole employmentStatus photo")
    .lean();
  return sanitizeClassGroup(populated);
}


