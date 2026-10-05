import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldSync, touchedFields } from "../services/moodle/autosync.js";
import { assertHandlerSucceeded } from "../services/moodle/worker.js";
import { moodleUsernameFor } from "../services/moodle/store.js";
import { verifyMainWebsiteSyncToken, verifyMainWebsiteSyncSignature } from "../services/moodle/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("main-website name sync fails closed and validates its shared token", () => {
  const previous = process.env.MAIN_WEBSITE_SYNC_TOKEN;
  try {
    delete process.env.MAIN_WEBSITE_SYNC_TOKEN;
    assert.deepEqual(verifyMainWebsiteSyncToken("anything"), { ok: false, reason: "not_configured" });
    process.env.MAIN_WEBSITE_SYNC_TOKEN = "replace-with-a-real-secret";
    assert.deepEqual(verifyMainWebsiteSyncToken("replace-with-a-real-secret"), { ok: false, reason: "not_configured" });
    process.env.MAIN_WEBSITE_SYNC_TOKEN = "a-secure-main-website-sync-token";
    assert.deepEqual(verifyMainWebsiteSyncToken(""), { ok: false, reason: "missing_token" });
    assert.deepEqual(verifyMainWebsiteSyncToken("wrong"), { ok: false, reason: "invalid_token" });
    assert.deepEqual(verifyMainWebsiteSyncToken("a-secure-main-website-sync-token"), { ok: true });
  } finally {
    if (previous === undefined) delete process.env.MAIN_WEBSITE_SYNC_TOKEN;
    else process.env.MAIN_WEBSITE_SYNC_TOKEN = previous;
  }
});

test("Hub batch signature matches HMAC-SHA256 over JSON users", () => {
  const token = "hub-shared-secret";
  const users = ["one@example.com", "two@example.com"];
  const signature = crypto.createHmac("sha256", token).update(JSON.stringify(users)).digest("hex");
  assert.deepEqual(verifyMainWebsiteSyncSignature(users, signature, token), { ok: true });
  assert.deepEqual(verifyMainWebsiteSyncSignature(users, "invalid", token), { ok: false, reason: "invalid_signature" });
  assert.deepEqual(verifyMainWebsiteSyncSignature(users, "", token), { ok: false, reason: "missing_signature" });
});

test("name sync exposes GET and bounded signed POST contracts", () => {
  const routes = read("routes/moodleRoutes.js");
  const service = read("services/moodle/syncMainWebsiteName.js");
  assert.match(routes, /router\.get\("\/main-website\/sync-name"/);
  assert.match(routes, /router\.post\("\/main-website\/sync-name"/);
  assert.match(routes, /users may contain at most 200 entries/);
  assert.match(routes, /verifyMainWebsiteSyncToken/);
  assert.match(routes, /X-StudiesMasters-Signature/);
  assert.match(routes, /syncMainWebsiteNames\(\{ emails: users \}\)/);
  assert.match(service, /syncMainWebsiteNames/);
});

test("SSO single-word names preserve an existing Moodle surname", () => {
  const sso = read("../moodle-sso/local/studiesmasters_sso/sso.php");
  assert.match(sso, /\$l !== '' && \$user->lastname !== \$l/);
  assert.doesNotMatch(sso, /\$nameSyncResult = trim\(\$nameSyncRes\['fullName'\]\)/);
  assert.match(sso, /Main website has no usable name/);
});

test("worker treats explicit ok:false as a failed job", () => {
  assert.throws(
    () => assertHandlerSucceeded({ ok: false, error: "mapping unavailable" }, { type: "syncProfile" }),
    /mapping unavailable/,
  );
  assert.doesNotThrow(() => assertHandlerSucceeded({ ok: true }, { type: "syncProfile" }));
  assert.doesNotThrow(() => assertHandlerSucceeded(undefined, { type: "legacyJob" }));
});

test("autosync recognizes relevant nested fields and ignores sync status", () => {
  assert.equal(shouldSync(touchedFields({ $set: { "policyAcceptance.terms": false } })), false);
  assert.equal(shouldSync(touchedFields({ $set: { email: "new@example.com" } })), true);
  assert.equal(shouldSync(touchedFields({ $addToSet: { "subjectNames.0": "Mathematics" } })), true);
  assert.equal(shouldSync(touchedFields({ $set: { "moodleSyncStatus.status": "SYNCED" } })), false);
  assert.equal(shouldSync(touchedFields({ $set: { "subjectsEnrolled": [] } })), true);
});

test("Moodle identity is stable and not derived from email", () => {
  assert.equal(moodleUsernameFor({ role: "student", id: "abc-123" }), "sm_s_abc123");
  assert.equal(moodleUsernameFor({ role: "teacher", id: "abc-123" }), "sm_t_abc123");
});

test("queue supports leases, stale-worker guards, and coalesced reruns", () => {
  const queue = read("services/moodle/queue.js");
  const model = read("models/SyncJob.js");
  assert.match(queue, /recoverExpiredLeases/);
  assert.match(queue, /leaseExpiresAt: null/);
  assert.match(queue, /leaseExpiresAt/);
  assert.match(queue, /runId \? \{ _id: jobId, runId, status: "in_progress" \}/);
  assert.match(queue, /rerunRequested/);
  assert.match(queue, /enqueueCoalesced/);
  assert.match(model, /leaseExpiresAt/);
  assert.match(model, /rerunRequested/);
});

test("reconciliation uses normal access resolution and repairs removals", () => {
  const source = read("services/moodle/reconciliation.js");
  assert.match(source, /resolveStudentAccess\(student\)/);
  assert.match(source, /const obsolete = held\.filter/);
  assert.match(source, /type: "syncProfile"/);
  assert.doesNotMatch(source, /getCourseIdsFor/);
});

test("live user lookup prefers stable username and idnumber before email", () => {
  const client = read("services/moodle/client.js");
  const createUser = read("services/moodle/createUser.js");
  assert.match(client, /findByStableIdentity/);
  assert.match(client, /getUsersByField\("username"/);
  assert.match(client, /getUsersByField\("idnumber"/);
  assert.match(createUser, /findByStableIdentity\(\{ username: link\.moodleUsername, idnumber \}\)/);
  assert.ok(createUser.indexOf("findByStableIdentity") < createUser.indexOf("searchUsersByEmail"));
});

test("category provisioning creates parents before children", () => {
  const source = read("services/moodle/provisioning.js");
  assert.ok(source.indexOf("await createStage(topLevel") < source.indexOf("await createStage(children"));
  assert.match(source, /parent category id is unavailable/);
  assert.doesNotMatch(source, /sort\(\(a, b\) => \(a\.level \? 1 : 0\)/);
});

test("REST payload contract remains form-encoded and version tolerant", () => {
  const source = read("services/moodle/client.js");
  assert.match(source, /core_user_create_users/);
  assert.match(source, /users\[0\]\[idnumber\]/);
  assert.match(source, /core_enrol_enrol_users/);
  assert.match(source, /enrol_manual_enrol_users/);
  assert.match(source, /enrolments\[\$\{i\}\]\[courseid\]/);
  assert.match(source, /core_calendar_create_calendar_events/);
  assert.match(source, /events\[\$\{i\}\]\[name\]/);
});

// ---------------------------------------------------------------------------
// Class-group isolation inside a SHARED Moodle course.
// Two class groups (e.g. "JHS 1 Mathematics Class 1" / "... Class 2") map to the
// same Moodle course; a plain course event would publish each group's schedule
// and Google Meet link to the other. Every published event must therefore carry
// the originating class group's Moodle group id, and anything that cannot be
// scoped must NOT be published at all (the backend stays the single source of
// truth; Moodle is display-only).
// ---------------------------------------------------------------------------
test("calendar events are scoped to the class group's Moodle group", () => {
  const cls = read("services/moodle/syncClass.js");
  const tt = read("services/moodle/syncTimetable.js");

  // The mirror group: stable idnumber + create + membership sync.
  assert.match(cls, /const GROUP_ID_PREFIX = "sm-cg-"/);
  assert.match(cls, /core_group_get_course_groups/);
  assert.match(cls, /core_group_create_groups/);
  assert.match(cls, /core_group_add_group_members/);
  assert.match(cls, /ensureClassGroupMoodleGroup/);
  assert.match(cls, /core_group_get_group_members/);

  // Both push paths attach the group id to the calendar event.
  assert.match(cls, /events\[0\]\[groupid\]/);
  assert.match(tt, /events\[0\]\[groupid\]/);
  assert.match(cls, /events\[0\]\[courseid\]/);
  assert.match(tt, /events\[0\]\[courseid\]/);
});

test("unscopable classes are never published (fail closed)", () => {
  const cls = read("services/moodle/syncClass.js");
  const tt = read("services/moodle/syncTimetable.js");

  // No site-wide and no course-wide fallbacks: the old `eventtype: "site"` /
  // ungrouped course event must not come back.
  assert.doesNotMatch(cls, /eventtype\]": courseId \? "course" : "site"/);
  assert.doesNotMatch(cls, /events\[0\]\[eventtype\]": "site"/);
  assert.doesNotMatch(tt, /events\[0\]\[eventtype\]": "site"/);
  assert.match(cls, /"events\[0\]\[eventtype\]": "course"/);

  // Explicit isolation gates with a durable retry, not a silent wider publish.
  assert.match(cls, /no-course-mapping/);
  assert.match(cls, /no-group-scope/);
  assert.match(cls, /refusing to publish a site-wide calendar event/);
  assert.match(cls, /refusing to publish a course-wide calendar event/);
  assert.match(cls, /queueClassSyncRetry\(\{ sessionId, action, payload, reason: "no-course-mapping" \}/);
  assert.match(cls, /queueClassSyncRetry\(\{ sessionId, action, payload, reason: "no-group-scope" \}/);

  // The timetable path skips (failed += 1) instead of creating unscoped events.
  assert.match(tt, /if \(!createParams\) \{[\s\S]{0,160}events\.push\(\{ sessionId: sid, error: reason \|\| "not-scopeable" \}\);[\s\S]{0,80}continue;/);

  // Success audit records the scope so an auditor can prove the isolation.
  assert.match(cls, /moodleGroupId: scope\.groupId/);
  assert.match(tt, /moodleGroupId: groupId/);
});

