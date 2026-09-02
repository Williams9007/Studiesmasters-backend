// services/moodle/courseMapper.js
//
// Centralised mapping between StudiesMasters subjects/packages/curricula and
// Moodle course ids. Reads from the CourseMapping collection (runtime-editable
// area) and falls back to the legacy per-Subject moodleCourseId for transitions.
//
//   getCourseIds({ subjects, packageName, curriculum, grade, subjectDocs })
//   upsertMapping({ ... }) / deleteMapping(key)   <- used by the admin endpoints

import CourseMapping from "../../models/CourseMapping.js";
import logger from "../../utils/logger.js";

const norm = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

/**
 * Resolve the Moodle course ids a student should be enrolled in.
 * Precedence:
 *   1. Explicit CourseMapping rows (subjectName + curriculum/package/grade)
 *   2. The subject's own moodleCourseId (legacy per-subject mapping)
 */
export async function getCourseIdsFor({ subjects = [], curriculum = null, packageName = null, grade = null }) {
  const ids = [];

  for (const subj of subjects) {
    const name = norm(subj?.name);

    // 1) Query CourseMapping, most specific first.
    const candidates = [
      { subjectName: name, curriculum: norm(curriculum), packageName: norm(packageName), grade: norm(grade) },
      { subjectName: name, curriculum: norm(curriculum), packageName: norm(packageName), grade: null },
      { subjectName: name, curriculum: null, packageName: null, grade: null },
    ];
    let mapped = null;
    for (const q of candidates) {
      const found = await CourseMapping.findOne({ enabled: true, ...withoutNull(q) }).lean();
      if (found) { mapped = found; break; }
    }
    if (mapped?.targets?.length) {
      for (const t of mapped.targets) if (t && !ids.includes(t.moodleCourseId)) ids.push(t.moodleCourseId);
      continue;
    }

    // 2) Legacy per-subject field — subj may be a populated doc or bare id with data.
    const sc = subj?.moodleCourseId;
    if (Number.isInteger(sc) && sc > 0 && !ids.includes(sc)) ids.push(sc);
  }

  // De-duplicate while preserving order.
  return ids;
}

function withoutNull(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) if (v != null) o[k] = v;
  return o;
}

/** Return a lightweight list of mappings for admin UI. */
export async function listMappings() {
  return CourseMapping.find({}).sort({ subjectName: 1, packageName: 1 }).lean();
}

/** Upsert a mapping by its natural key (subjectName + packageName + curriculum + grade). */
export async function upsertMapping({ subjectName, packageName = null, curriculum = null, grade = null, targets = [], createdBy = "admin" }) {
  const key = withoutNull({ subjectName: norm(subjectName), packageName: norm(packageName),
    curriculum: norm(curriculum), grade: norm(grade) });
  const cleanTargets = (Array.isArray(targets) ? targets : [])
    .map((t) => ({ moodleCourseId: parseInt(t?.moodleCourseId ?? t, 10), roleShortName: t?.roleShortName || "student" }))
    .filter((t) => Number.isInteger(t.moodleCourseId) && t.moodleCourseId > 0);
  const mapping = await CourseMapping.findOneAndUpdate(
    key,
    { $set: { targets: cleanTargets, enabled: true, createdBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  logger.info("Course mapping upserted:", key);
  return mapping;
}

export async function removeMapping(key) {
  const res = await CourseMapping.deleteOne(withoutNull(key));
  return { deleted: !!res.deletedCount };
}

const courseMapper = { getCourseIdsFor, listMappings, upsertMapping, removeMapping };
export default courseMapper;