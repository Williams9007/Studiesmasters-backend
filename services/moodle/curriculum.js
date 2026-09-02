// services/moodle/curriculum.js
//
// Canonical curriculum structure for automatic Moodle provisioning. This is the
// single declarative description of what should exist in Moodle:
//
//   2 curricula x 9 grades x 3 subjects = 54 courses, organised as:
//
//     GES
//       Primary   -> Primary 4 / Primary 5 / Primary 6
//       JHS       -> JHS 1 / JHS 2 / JHS 3
//       SHS       -> SHS 1 / SHS 2 / SHS 3
//     Cambridge
//       Primary / JHS / SHS (same grades)
//
// Packages never create courses; they only select which of the existing
// courses a student is enrolled in. The package -> subject mapping is
// configurable at runtime via the MOODLE_PACKAGE_MAP_JSON env var, e.g.
//
//   MOODLE_PACKAGE_MAP_JSON={"Starter":["Mathematics"],"Standard":["Mathematics","Science"],"Premium":["Mathematics","Science","English"]}

export const CURRICULA = ["GES", "Cambridge"];

export const LEVEL_GROUPS = [
  { name: "Primary", grades: ["Primary 4", "Primary 5", "Primary 6"] },
  { name: "JHS", grades: ["JHS 1", "JHS 2", "JHS 3"] },
  { name: "SHS", grades: ["SHS 1", "SHS 2", "SHS 3"] },
];

export const GRADES = LEVEL_GROUPS.flatMap((g) => g.grades);

export const SUBJECTS = ["Mathematics", "Science", "English"];

// Level group a grade belongs to (used to pick the Moodle subcategory).
export function levelGroupForGrade(grade) {
  const norm = String(grade || "").trim().toLowerCase();
  return LEVEL_GROUPS.find((g) => g.grades.some((x) => x.toLowerCase() === norm)) || null;
}

// Runtime-configurable package -> subjects mapping (backend authority).
const DEFAULT_PACKAGE_MAP = {
  Starter: ["Mathematics"],
  Standard: ["Mathematics", "Science"],
  Premium: ["Mathematics", "Science", "English"],
};

export function packageSubjectMap() {
  const raw = String(process.env.MOODLE_PACKAGE_MAP_JSON || "").trim();
  if (!raw) return { ...DEFAULT_PACKAGE_MAP };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out = { ...DEFAULT_PACKAGE_MAP };
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.map(String);
      }
      return out;
    }
  } catch { /* malformed -> fall back to defaults */ }
  return { ...DEFAULT_PACKAGE_MAP };
}

// ---- Internal package IDs -------------------------------------------------
// Marketing/display names must never be the key used for synchronization.
// Every plan variant normalizes to one of these stable internal IDs:
//   "Starter Plan" | "starter" | "STARTER PLAN"  ->  "starter"
export const PACKAGE_IDS = {
  starter: {
    displayName: "Starter Plan",
    subjects: ["Mathematics"],
  },
  standard: {
    displayName: "Standard Plan",
    subjects: ["Mathematics", "Science"],
  },
  premium: {
    displayName: "Premium Plan",
    subjects: ["Mathematics", "Science", "English"],
  },
};

export const PACKAGE_ID_LIST = Object.keys(PACKAGE_IDS);

/** Normalize any display/marketing plan name to its internal package id
 *  ("starter" | "standard" | "premium") or null when unrecognized. */
export function resolvePackageId(name) {
  const norm = normalizePlanName(name);
  if (!norm) return null;
  if (PACKAGE_IDS[norm]) return norm;
  for (const id of PACKAGE_ID_LIST) {
    if (normalizePlanName(PACKAGE_IDS[id].displayName) === norm) return id;
  }
  return null;
}

/** Internal package record by id (or by any display name). */
export function packageById(idOrName) {
  const id = resolvePackageId(idOrName);
  return id ? { packageId: id, ...PACKAGE_IDS[id] } : null;
}

/** Subjects a student in `packageName` should be enrolled in (unknown package -> none).
 *  Matching is tolerant: case-insensitive and ignores a trailing "Plan"/"Package"
 *  suffix, so "Starter Plan", "starter" and "STARTER PLAN" all match "Starter". */
export function subjectsForPackage(packageName) {
  const map = packageSubjectMap();
  const norm = normalizePlanName(packageName);
  if (!norm) return [];
  for (const [key, subs] of Object.entries(map)) {
    if (normalizePlanName(key) === norm) return subs;
  }
  return [];
}

function normalizePlanName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]*(plan|package)$/i, "")
    .trim();
}

/** Normalize a subject name ("maths", "MATHEMATICS", "math") to the canonical
 *  subject ("Mathematics") or null when it matches none of the catalogue. */
export function normalizeSubject(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  const aliases = {
    mathematics: ["mathematics", "math", "maths", "core maths"],
    science: ["science", "general science", "integrated science"],
    english: ["english", "english language", "eng"],
  };
  for (const [canonical, list] of Object.entries(aliases)) {
    if (list.includes(n)) return canonical.charAt(0).toUpperCase() + canonical.slice(1);
  }
  return null;
}

/** The complete expected Moodle category tree: [{ curriculum, level, idnumber }] */
export function expectedCategories() {
  const tree = [];
  for (const curriculum of CURRICULA) {
    tree.push({ curriculum, level: null, idnumber: `sm-${slug(curriculum)}` });
    for (const { name: level } of LEVEL_GROUPS) {
      tree.push({ curriculum, level, idnumber: `sm-${slug(curriculum)}-${slug(level)}` });
    }
  }
  return tree;
}

/** The complete expected course list: [{ curriculum, grade, subject, level, categoryIdnumber, courseIdnumber }] */
export function expectedCourses() {
  const courses = [];
  for (const curriculum of CURRICULA) {
    for (const { name: level, grades } of LEVEL_GROUPS) {
      for (const grade of grades) {
        for (const subject of SUBJECTS) {
          courses.push({
            curriculum,
            grade,
            subject,
            level,
            categoryIdnumber: `sm-${slug(curriculum)}-${slug(level)}`,
            courseIdnumber: `sm-${slug(curriculum)}-${slug(grade)}-${slug(subject)}`,
            fullName: `${grade} ${subject} (${curriculum})`,
            shortName: `${slug(grade)}-${slug(subject)}-${slug(curriculum)}`.slice(0, 40),
          });
        }
      }
    }
  }
  return courses;
}

export const COURSE_COUNT = CURRICULA.length * GRADES.length * SUBJECTS.length; // 54

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default { CURRICULA, LEVEL_GROUPS, GRADES, SUBJECTS, COURSE_COUNT, levelGroupForGrade, packageSubjectMap, subjectsForPackage, resolvePackageId, packageById, PACKAGE_IDS, PACKAGE_ID_LIST, normalizeSubject, expectedCategories, expectedCourses };
