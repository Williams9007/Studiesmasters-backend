// services/moodle/provisioning.js
//
// Automatic Moodle structure provisioning. Reads the canonical curriculum
// (services/moodle/curriculum.js) and mirrors it into Moodle:
//
//   1. Ensure the 2 top-level categories (GES, Cambridge).
//   2. Ensure the 3 level subcategories under each (Primary / JHS / SHS).
//   3. Ensure the 2 x 9 x 3 = 54 courses inside the right subcategory.
//   4. Persist every moodleCourseId + categoryId in the CourseMapping
//      collection (MongoDB is the single source of truth for identity;
//      CourseMapping records how Moodle mirrors it).
//
// Idempotency: every category and course is identified by a deterministic
// `idnumber` (e.g. "sm-ges", "sm-ges-primary", "sm-ges-primary-4-mathematics").
// Existing idnumbers are looked up first and skipped, so rerunning this any
// number of times never duplicates categories or courses. A CourseMapping row
// is checked before Moodle is called, so locally known courses never hit WS.

import CourseMapping from "../../models/CourseMapping.js";
import { client } from "./client.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";
import { CURRICULA, SUBJECTS, expectedCategories, expectedCourses, COURSE_COUNT } from "./curriculum.js";

const levelSlug = (grade) => { // documented for operators; used by idnumber scheme
  const g = String(grade || "").toLowerCase();
  if (g.startsWith("primary")) return "primary";
  if (g.startsWith("jhs")) return "jhs";
  return "shs";
};
export { levelSlug };

// ---- Categories ------------------------------------------------------------
// Ensures the 8-category tree. Returns a Map: idnumber -> { id }.

async function ensureCategories() {
  const expected = expectedCategories();
  const categoryIds = new Map();

  if (!config.dryRun) {
    // Existing Moodle categories, indexed by idnumber.
    const existing = await client.getCategories(expected.map((c) => c.idnumber)).catch(() => []);
    for (const c of existing || []) if (c.idnumber && c.id) categoryIds.set(c.idnumber, c.id);
  }

  // Create the missing ones, parents (top-level) before subcategories.
  const missing = expected.filter((c) => !categoryIds.has(c.idnumber));
  const ordered = [...missing].sort((a, b) => (a.level ? 1 : 0) - (b.level ? 1 : 0));
  const created = [];

  if (ordered.length) {
    const payload = ordered.map((c) => ({
      name: c.level || c.curriculum,
      idnumber: c.idnumber,
      parent: c.level ? categoryIds.get(`sm-${c.curriculum.toLowerCase()}`) || 0 : 0,
    }));
    const results = await client.createCategories(payload);
    for (let i = 0; i < payload.length; i += 1) {
      const id = results?.[i]?.id ?? null;
      if (id != null) categoryIds.set(payload[i].idnumber, id);
      created.push({ idnumber: payload[i].idnumber, id });
    }
  }

  return { categoryIds, createdCategories: created };
}

// ---- Courses ---------------------------------------------------------------

async function ensureCourses(categoryIds) {
  const expected = expectedCourses();

  // Existing Moodle courses (idnumber -> moodle id).
  const courseIds = new Map();
  if (!config.dryRun) {
    const all = await client.getCourses(expected.map((c) => c.courseIdnumber)).catch(() => []);
    for (const c of all || []) if (c.idnumber && c.id) courseIds.set(c.idnumber, c.id);
  }

  // Locally known rows are checked FIRST (Mongo is authoritative locally) so
  // repeated runs never re-call Moodle for courses already provisioned.
  const rows = await CourseMapping.find({
    subjectName: { $in: SUBJECTS }, curriculum: { $in: CURRICULA }, packageName: null,
  }).lean();
  for (const r of rows) {
    const t = r.targets?.[0];
    if (t?.moodleCourseId != null) {
      const key = `${r.curriculum}|${r.grade}|${r.subjectName}`;
      const exp = expected.find((c) => `${c.curriculum}|${c.grade}|${c.subject}` === key);
      if (exp) courseIds.set(exp.courseIdnumber, t.moodleCourseId);
    }
  }

  // Create the missing courses in one batch.
  const toCreate = expected.filter((c) => !courseIds.has(c.courseIdnumber));
  const createdCourses = [];
  if (toCreate.length) {
    const payload = toCreate.map((c) => ({
      fullname: c.fullName,
      shortname: c.shortName,
      categoryid: categoryIds.get(c.categoryIdnumber) || 0,
      idnumber: c.courseIdnumber,
    }));
    const results = await client.createCourses(payload);
    for (let i = 0; i < payload.length; i += 1) {
      const id = results?.[i]?.id ?? null;
      if (id != null) courseIds.set(payload[i].idnumber, id);
      createdCourses.push({ idnumber: payload[i].idnumber, moodleCourseId: id });
    }
  }

  return { courseIds, createdCourses };
}

// Persists/refreshes a CourseMapping row for every expected course.
async function persistMappings(categoryIds) {
  const expected = expectedCourses();
  const rows = await CourseMapping.find({
    subjectName: { $in: SUBJECTS }, curriculum: { $in: CURRICULA }, packageName: null,
  }).lean();
  const known = new Map(rows.map((r) => [`${r.curriculum}|${r.grade}|${r.subjectName}`, r]));

  const persisted = [];
  for (const c of expected) {
    const key = `${c.curriculum}|${c.grade}|${c.subject}`;
    const exp = known.get(key);
    const moodleCourseId = exp?.targets?.[0]?.moodleCourseId ?? null;
    const categoryId = exp?.targets?.[0]?.categoryId ?? categoryIds.get(c.categoryIdnumber) ?? null;

    if (moodleCourseId == null) {
      persisted.push({ curriculum: c.curriculum, grade: c.grade, subject: c.subject, moodleCourseId: null, dryRun: true });
      continue;
    }
    const mapping = await CourseMapping.findOneAndUpdate(
      { subjectName: c.subject, packageName: null, curriculum: c.curriculum, grade: c.grade },
      {
        $set: {
          targets: [{ moodleCourseId, roleShortName: "student", categoryId }],
          enabled: true,
          createdBy: "provisioning",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    persisted.push({ curriculum: c.curriculum, grade: c.grade, subject: c.subject, moodleCourseId, categoryId, mappingId: mapping._id.toString() });
  }
  return persisted;
}

// ---- Public entry points ----------------------------------------------------

/**
 * Provision the full curriculum structure into Moodle. Idempotent: safe to run
 * any number of times; only missing categories/courses are created.
 */
export async function provisionStructure({ req = null } = {}) {
  const started = Date.now();
  logger.info("Moodle provisioning started");

  const { categoryIds, createdCategories } = await ensureCategories();
  const { createdCourses } = await ensureCourses(categoryIds);
  const persisted = await persistMappings(categoryIds);

  const report = {
    ok: true,
    dryRun: config.dryRun,
    expected: { categories: CURRICULA.length * 4, courses: COURSE_COUNT },
    created: { categories: createdCategories.length, courses: createdCourses.length },
    mappings: persisted.filter((p) => p.moodleCourseId != null).length,
    durationMs: Date.now() - started,
  };

  await audit({
    action: "PROVISION_STRUCTURE", outcome: "success",
    detail: { created: report.created, dryRun: config.dryRun }, req, createdBy: "provisioning",
  });
  logger.info("Moodle provisioning complete:", report);
  return report;
}

/**
 * Status report for the admin dashboard / provisioning endpoint. Counts what
 * actually exists in CourseMapping vs what the curriculum expects.
 */
export async function provisionStatus() {
  const expected = expectedCourses();
  const mappings = await CourseMapping.find({
    subjectName: { $in: SUBJECTS }, curriculum: { $in: CURRICULA }, packageName: null,
  }).lean();

  const expectedKeys = new Set(expected.map((c) => `${c.curriculum}|${c.grade}|${c.subject}`));
  const provisionedKeys = new Set();
  const categories = new Set();
  const courses = [];
  for (const m of mappings) {
    const key = `${m.curriculum}|${m.grade}|${m.subjectName}`;
    if (!expectedKeys.has(key)) continue;
    const t = m.targets?.[0];
    if (t?.moodleCourseId != null) {
      provisionedKeys.add(key);
      if (t.categoryId != null) categories.add(t.categoryId);
      courses.push({ curriculum: m.curriculum, grade: m.grade, subject: m.subjectName, moodleCourseId: t.moodleCourseId, categoryId: t.categoryId });
    }
  }

  return {
    expectedCategories: CURRICULA.length * 4,
    expectedCourses: COURSE_COUNT,
    provisionedCourses: provisionedKeys.size,
    provisionedCategories: categories.size,
    missingCourses: COURSE_COUNT - provisionedKeys.size,
    fullyProvisioned: provisionedKeys.size === COURSE_COUNT,
    dryRun: config.dryRun,
    courses,
  };
}

export default { provisionStructure, provisionStatus };
