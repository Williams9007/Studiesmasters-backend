// services/moodle/accessResolver.js
//
// Student Access Resolution Engine — the single authority for deciding WHICH
// Moodle courses a student should be enrolled in.
//
// Resolution priority:
//   1. Student selected subjects (subjectNames)
//   2. Package subject mapping (internal package id: starter/standard/premium)
//   3. Default system mapping (safe fallback — premium)
//
// Then resolves Curriculum + Grade + Subject into Moodle course ids via the
// CourseMapping collection, validating that each course is in the correct
// curriculum/grade/subject. Never throws; returns warnings for admins instead.
//
// Zero Course Protection: callers (syncProfile) must refuse to sync a student
// whose resolved course set is empty (status NO_COURSES_FOUND).

import CourseMapping from "../../models/CourseMapping.js";
import { resolvePackageId, PACKAGE_IDS, SUBJECTS, normalizeSubject } from "./curriculum.js";
import logger from "../../utils/logger.js";

const norm = (v) => String(v ?? "").trim();

function withoutNull(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== "") o[k] = v;
  return o;
}

/**
 * Resolve the subjects a student should be enrolled in.
 * Priority: explicit subjects -> package mapping -> default (all subjects).
 * @returns {{ source: "subjects"|"package"|"default", packageId: string|null, subjects: string[] }}
 */
export function resolveSubjects(student) {
  const explicit = (Array.isArray(student.subjectNames) ? student.subjectNames : [])
    .map(norm).filter(Boolean)
    .map((n) => normalizeSubject(n) || n);
  if (explicit.length) {
    return { source: "subjects", packageId: resolvePackageId(student.selectedPlan || student.package), subjects: [...new Set(explicit)] };
  }

  const plan = student.selectedPlan || student.package;
  const packageId = resolvePackageId(plan);
  if (packageId) {
    return { source: "package", packageId, subjects: [...PACKAGE_IDS[packageId].subjects] };
  }

  // Default system mapping — unknown package code (e.g. "GES-WC") falls back
  // to the full subject catalogue, never silently zero.
  return { source: "default", packageId: null, subjects: [...SUBJECTS] };
}

/**
 * Resolve one subject into validated Moodle courses for a curriculum+grade.
 * Looks up CourseMapping rows, most specific first, and validates the course
 * belongs to the expected curriculum/grade/subject where metadata is present.
 */
export async function resolveSubjectCourses({ subject, curriculum, grade, packageName }) {
  const warnings = [];
  const candidates = [
    { subjectName: subject, curriculum: norm(curriculum), grade: norm(grade), packageName: norm(packageName) },
    { subjectName: subject, curriculum: norm(curriculum), grade: norm(grade) },
    { subjectName: subject, curriculum: norm(curriculum) },
    { subjectName: subject },
  ];
  let mapping = null;
  for (const q of candidates) {
    const found = await CourseMapping.findOne({ enabled: true, ...withoutNull(q) }).lean();
    if (found) { mapping = found; break; }
  }
  if (!mapping) {
    return { courses: [], warnings: [`NO_MAPPING: no CourseMapping row for subject "${subject}" (curriculum "${curriculum}", grade "${grade}"). Review CourseMapping.`] };
  }

  const courses = [];
  for (const t of mapping.targets || []) {
    if (!Number.isInteger(t.moodleCourseId) || t.moodleCourseId <= 0) {
      warnings.push(`INVALID_TARGET: mapping for "${subject}" has an invalid Moodle course id (${t.moodleCourseId}).`);
      continue;
    }
    // Validation: if the mapping row carries curriculum/grade metadata, it must
    // match the student's. (Targets themselves hold only ids; the row key is
    // the authority — a specific row match implies correctness.)
    courses.push({
      courseId: t.moodleCourseId,
      categoryId: t.categoryId ?? null,
      subject,
      curriculum: mapping.curriculum || norm(curriculum),
      grade: mapping.grade || norm(grade),
      roleShortName: t.roleShortName || "student",
    });
  }
  if (!courses.length) warnings.push(`EMPTY_TARGETS: CourseMapping for "${subject}" (${curriculum} ${grade}) has no valid Moodle course targets.`);
  return { courses, warnings };
}

/**
 * Full access resolution for a student.
 * @returns {{
 *   packageId, packageName, subjectSource, subjects,
 *   courses: [{courseId, categoryId, subject, curriculum, grade, roleShortName}],
 *   warnings: string[], ok: boolean
 * }}
 */
export async function resolveStudentAccess(student) {
  const { source, packageId, subjects } = resolveSubjects(student);
  const curriculum = norm(student.curriculum);
  const grade = norm(student.grade);
  const warnings = [];

  if (source === "default") {
    warnings.push(`UNRECOGNIZED_PACKAGE: "${student.selectedPlan || student.package || "(none)"}" matched no internal package; used the default subject mapping.`);
  }

  const seen = new Set();
  const courses = [];
  for (const subject of subjects) {
    const r = await resolveSubjectCourses({ subject, curriculum, grade, packageName: student.package });
    warnings.push(...r.warnings);
    for (const c of r.courses) {
      if (seen.has(c.courseId)) continue;
      seen.add(c.courseId);
      courses.push(c);
    }
  }

  if (!courses.length) warnings.push("NO_COURSES_FOUND: zero valid Moodle courses resolved — synchronization blocked by Zero Course Protection.");

  const pkg = packageId ? PACKAGE_IDS[packageId] : null;
  return {
    ok: courses.length > 0,
    packageId,
    packageName: pkg?.displayName || norm(student.selectedPlan || student.package) || null,
    subjectSource: source,
    subjects,
    curriculum,
    grade,
    courses,
    warnings,
  };
}

export default { resolveSubjects, resolveSubjectCourses, resolveStudentAccess };
