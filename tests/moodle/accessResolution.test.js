// tests/moodle/accessResolution.test.js
//
// Automated tests for the Moodle Access Resolution Engine (no DB required —
// exercises the pure resolution logic).
// Run:  node tests/moodle/accessResolution.test.js
import assert from "node:assert/strict";
import { resolvePackageId, subjectsForPackage, normalizeSubject, PACKAGE_IDS } from "../../services/moodle/curriculum.js";
import { resolveSubjects } from "../../services/moodle/accessResolver.js";

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log("Package normalization:");
for (const variant of ["starter", "Starter", "STARTER PLAN", "starter plan", "Starter Plan", " Starter Plan "]) {
  t(`"${variant}" -> starter`, () => assert.equal(resolvePackageId(variant), "starter"));
}
for (const variant of ["standard", "Standard Plan", "STANDARD"]) {
  t(`"${variant}" -> standard`, () => assert.equal(resolvePackageId(variant), "standard"));
}
for (const variant of ["premium", "Premium Plan", "PREMIUM PLAN"]) {
  t(`"${variant}" -> premium`, () => assert.equal(resolvePackageId(variant), "premium"));
}
t("unknown package code -> null", () => assert.equal(resolvePackageId("GES-WC"), null));
t("empty -> null", () => assert.equal(resolvePackageId(""), null));

console.log("Package -> subjects:");
t("Starter => Mathematics", () =>
  assert.deepEqual(subjectsForPackage("Starter Plan"), ["Mathematics"]));
t("Standard => Mathematics+Science", () =>
  assert.deepEqual(subjectsForPackage("Standard Plan"), ["Mathematics", "Science"]));
t("Premium => Mathematics+Science+English", () =>
  assert.deepEqual(subjectsForPackage("premium plan"), ["Mathematics", "Science", "English"]));
t("Invalid package => no subjects (subjectsForPackage)", () =>
  assert.deepEqual(subjectsForPackage("GES-WC"), []));

console.log("Subject normalization:");
t("maths -> Mathematics", () => assert.equal(normalizeSubject("maths"), "Mathematics"));
t("ENGLISH LANGUAGE -> English", () => assert.equal(normalizeSubject("ENGLISH LANGUAGE"), "English"));
t("unknown -> null", () => assert.equal(normalizeSubject("French"), null));

console.log("Access resolution priority (selected subjects > package > default):");
t("selected subjects override Premium package", () => {
  const r = resolveSubjects({ subjectNames: ["Mathematics", "Science"], package: "Premium Plan", selectedPlan: "Premium Plan" });
  assert.equal(r.source, "subjects");
  assert.deepEqual([...r.subjects].sort(), ["Mathematics", "Science"]);
});
t("package mapping when no explicit subjects", () => {
  const r = resolveSubjects({ subjectNames: [], selectedPlan: "Standard Plan" });
  assert.equal(r.source, "package");
  assert.equal(r.packageId, "standard");
  assert.deepEqual(r.subjects, ["Mathematics", "Science"]);
});
t("invalid package (GES-WC) falls back to default mapping", () => {
  const r = resolveSubjects({ subjectNames: [], package: "GES-WC" });
  assert.equal(r.source, "default");
  assert.deepEqual(r.subjects, Object.keys(PACKAGE_IDS) && ["Mathematics", "Science", "English"]);
});

console.log(`\n${passed} assertions passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
