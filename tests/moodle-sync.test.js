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
