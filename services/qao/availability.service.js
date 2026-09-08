import Teacher from "../../models/teacher.js";
import { TEACHER_SAFE_PROJECTION } from "./sanitize.js";
import { emitToQaos, emitToTeacher } from "./notify.js";
import { logQaoAction } from "./audit.service.js";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function validateSlot(slot) {
  if (!slot || !WEEKDAYS.some((d) => d.toLowerCase() === String(slot.day || "").toLowerCase())) {
    throw new Error("day must be a valid weekday (Monday-Sunday)");
  }
  const start = toMinutes(slot.start);
  const end = toMinutes(slot.end);
  if (start === null || end === null) throw new Error("start and end must be valid HH:MM times");
  if (end <= start) throw new Error("end time must be after start time");
  return {
    day: WEEKDAYS.find((d) => d.toLowerCase() === String(slot.day).toLowerCase()),
    start: slot.start,
    end: slot.end,
  };
}

function assertNoOverlap(slots, candidate, ignoreSlotId = null) {
  const start = toMinutes(candidate.start);
  const end = toMinutes(candidate.end);
  for (const s of slots) {
    if (String(s.day).toLowerCase() !== String(candidate.day).toLowerCase()) continue;
    if (ignoreSlotId && String(s._id) === String(ignoreSlotId)) continue;
    if (start < toMinutes(s.end) && end > toMinutes(s.start)) {
      throw new Error(`Overlapping availability slot: ${s.start}-${s.end} on ${s.day}`);
    }
  }
}

async function getTeacher(teacherId) {
  const teacher = await Teacher.findById(teacherId).select("_id fullName availability");
  if (!teacher) throw new Error("Teacher not found");
  return teacher;
}

function notifyAvailability(teacher) {
  emitToQaos("availability:updated", { teacherId: teacher._id, teacher: teacher.fullName });
  emitToTeacher(teacher._id, "availability:updated", { teacherId: teacher._id });
}

export async function getAvailability(teacherId) {
  const teacher = await Teacher.findById(teacherId)
    .select("_id fullName employmentStatus availability")
    .lean();
  if (!teacher) throw new Error("Teacher not found");
  return teacher;
}

export async function addSlot(teacherId, slot) {
  const teacher = await getTeacher(teacherId);
  const clean = validateSlot(slot);
  assertNoOverlap(teacher.availability || [], clean);
  teacher.availability.push(clean);
  await teacher.save();
  notifyAvailability(teacher);
  await logQaoAction({ action: "AVAILABILITY_ADDED", resource: "Teacher", resourceId: teacherId, details: { day: clean.day, start: clean.start, end: clean.end } });
  return teacher.availability.id(teacher.availability[teacher.availability.length - 1]._id);
}

export async function updateSlot(teacherId, slotId, patch = {}) {
  const teacher = await getTeacher(teacherId);
  const slot = (teacher.availability || []).find((s) => String(s._id) === String(slotId));
  if (!slot) throw new Error("Availability slot not found");
  const clean = validateSlot({
    day: patch.day ?? slot.day,
    start: patch.start ?? slot.start,
    end: patch.end ?? slot.end,
  });
  assertNoOverlap(teacher.availability || [], clean, slotId);
  slot.day = clean.day;
  slot.start = clean.start;
  slot.end = clean.end;
  await teacher.save();
  notifyAvailability(teacher);
  await logQaoAction({ action: "AVAILABILITY_UPDATED", resource: "Teacher", resourceId: teacherId, details: { slotId: String(slotId), day: clean.day, start: clean.start, end: clean.end } });
  return slot;
}

export async function deleteSlot(teacherId, slotId) {
  const teacher = await getTeacher(teacherId);
  const slot = (teacher.availability || []).find((s) => String(s._id) === String(slotId));
  if (!slot) throw new Error("Availability slot not found");
  slot.deleteOne();
  await teacher.save();
  notifyAvailability(teacher);
  await logQaoAction({ action: "AVAILABILITY_DELETED", resource: "Teacher", resourceId: teacherId, details: { slotId: String(slotId) } });
  return { ok: true };
}

// Availability report: available today / busy (on approved leave today) / unavailable
export async function availabilityReport() {
  const teachers = await Teacher.find({ employmentStatus: { $ne: "former" } })
    .select("_id fullName availability employmentStatus")
    .lean();
  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
  let available = 0;
  let unavailable = 0;
  for (const t of teachers) {
    const slots = (t.availability || []).filter((s) => s && s.day);
    if (!slots.length || slots.some((s) => String(s.day).toLowerCase() === today.toLowerCase())) {
      available += 1;
    } else {
      unavailable += 1;
    }
  }
  return { today, total: teachers.length, available, unavailable, busy: 0 };
}
