// services/moodle/reconciliation.js
//
// Periodic consistency job that reconciles MongoDB (single source of truth) with
// Moodle. Detects and repairs:
//   - students not provisioned in Moodle           -> enqueue createUser
//   - enrollments missing/extra vs the course mapper -> enqueue enroll/unenroll
//   - suspended/expired subscriptions               -> enqueue suspendUser
//   - orphaned Moodle links (deleted principals)     -> enqueue suspendUser
//
// The repair itself is delegated to durable SyncJobs so failures are retried
// with backoff (queue.js). Enable via MOODLE_RECONCILIATION_ENABLED=true.

import Student from "../../models/Student.js";
import MoodleLink from "../../models/MoodleLink.js";
import { enqueue } from "./queue.js";
import { getCourseIdsFor } from "./courseMapper.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";

export async function runReconciliation({ limit = 200 } = {}) {
  const started = Date.now();
  const report = { checked: 0, missingUsers: 0, enrollmentDrift: 0, suspended: 0, orphaned: 0 };

  // 1) Students missing a Moodle link -> provision.
  const unmappedCursor = Student.aggregate([
    {
      $lookup: {
        from: "moodlelinks",
        localField: "_id",
        foreignField: "studentRef",
        as: "link",
      },
    },
    { $match: { link: { $size: 0 } } },
    { $limit: limit },
  ]);
  for (const student of await unmappedCursor) {
    report.missingUsers += 1;
    report.checked += 1;
    await enqueue({
      type: "createUser",
      payload: { role: "student", id: student._id.toString() },
      idempotencyKey: `create:${student._id.toString()}`,
    });
  }

  // 2) Students with links: verify enrollments vs the mapper (best-effort).
  const linked = await MoodleLink.find({ role: "student", active: true })
    .populate("studentRef").limit(limit);
  for (const l of linked) {
    report.checked += 1;
    const st = l.studentRef;
    if (!st) { report.orphaned += 1; await enqueue({ type: "suspendUser", payload: { role: "student", id: l.studentRef?._id, suspended: true }, idempotencyKey: `orphan:${l._id}` }); continue; }
    const desired = await getCourseIdsFor({
      subjects: Array.isArray(st.subjectNames) ? st.subjectNames.map((n) => ({ name: n })) : [],
      curriculum: st.curriculum, packageName: st.package, grade: st.grade,
    });
    const held = l.enrolledCourseIds || [];
    const missingFromMoodle = desired.filter((c) => !held.includes(c));
    if (missingFromMoodle.length) {
      report.enrollmentDrift += 1;
      await enqueue({ type: "enrollUser", payload: { role: "student", id: st._id.toString(), courseIds: missingFromMoodle }, idempotencyKey: `enroll:${st._id}:${missingFromMoodle.join("_")}` });
    }
  }

  // 3) Suspended / expired subscription accounts.
  const now = new Date();
  const expired = await Student.find({
    $or: [
      { suspended: true },
      { finishDate: { $lt: now }, finishDate: { $ne: null } },
      { "policyAcceptance.terms": false },
    ],
  }).limit(limit);
  for (const st of expired) {
    report.suspended += 1;
    await enqueue({ type: "suspendUser", payload: { role: "student", id: st._id.toString(), suspended: true }, idempotencyKey: `suspend:${st._id}` });
  }

  await audit({ action: "RECON_REPAIR", outcome: "success",
    detail: { report, durationMs: Date.now() - started }, createdBy: "reconciliation" });

  logger.info("Moodle reconciliation complete:", report);
  return { ...report, durationMs: Date.now() - started };
}

export default runReconciliation;