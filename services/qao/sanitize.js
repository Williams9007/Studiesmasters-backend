// QAO response sanitization layer.
// Every Tutor Manager (QAO) response MUST pass through sanitizeForQao() so
// that no student records, ObjectIds, or PII ever leave the server.

export const TEACHER_SAFE_PROJECTION = "-password -resetToken -resetTokenExpiry";

export function sanitizeClassGroup(group) {
  const obj = group && typeof group.toObject === "function" ? group.toObject({ virtuals: false }) : { ...group };
  const studentCount = Array.isArray(obj.students)
    ? obj.students.length
    : Number(obj.students ?? obj.studentCount ?? 0);
  delete obj.students;
  delete obj.studentIds;
  if (obj.teacher && typeof obj.teacher === "object") {
    const t = obj.teacher;
    delete t.password;
    delete t.resetToken;
    delete t.resetTokenExpiry;
    delete t.internalNotes;
  }
  return { ...obj, studentCount };
}

export function sanitizeTeacher(teacher) {
  const obj = teacher && typeof teacher.toObject === "function" ? teacher.toObject() : { ...teacher };
  delete obj.password;
  delete obj.resetToken;
  delete obj.resetTokenExpiry;
  return obj;
}

export function sanitizeForQao(value) {
  if (Array.isArray(value)) return value.map(sanitizeForQao);
  if (value && typeof value === "object") {
    if (value.students !== undefined && (value.code || value.subject)) return sanitizeClassGroup(value);
    if (value.password !== undefined || value.resetToken !== undefined) return sanitizeTeacher(value);
  }
  return value;
}
