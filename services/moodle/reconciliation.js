// services/moodle/reconciliation.js
//
// Periodic consistency job that reconciles MongoDB (single source of truth) with
// Moodle. Detects and repairs:
//   - students not provisioned in Moodle           -> enqueue full profile sync
//   - enrollments missing/extra vs access resolver  -> enqueue full profile sync
//   - suspended/expired subscriptions               -> enqueue suspendUser
//   - orphaned Moodle links (deleted principals)     -> enqueue suspendUser
//
// The repair itself is delegated to durable SyncJobs so failures are retried
// with backoff (queue.js). Enable via MOODLE_RECONCILIATION_ENABLED=true.

import Student from "../../models/Student.js";
import MoodleLink from "../../models/MoodleLink.js";
import { enqueueCoalesced } from "./queue.js";
import { resolveStudentAccess } from "./accessResolver.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";

export async function runReconciliation({ limit = 200 } = {}) {
  const started = Date.now();
  const report = { checked: 0, missingUsers: 0, enrollmentDrift: 0, obsoleteEnrollments: 0, noCourses: 0, suspended: 0, orphaned: 0 };

  // 1) Students missing a Moodle link -> full idempotent profile sync. This creates
  // the account and then resolves enrolments; createUser alone would be partial.
  const unmappedCursor = Student.aggregate([
    { $lookup: { from: "moodlelinks", localField: "_id", foreignField: "studentRef", as: "link" } },
    { $match: { link: { $size: 0 } } },
    { $limit: limit },
  ]);
  for (const student of await unmappedCursor) {
    report.missingUsers += 1;
    report.checked += 1;
    await enqueueCoalesced({
      type: "syncProfile",
      payload: { role: "student", id: student._id.toString() },
      idempotencyKey: `syncProfile:student:${student._id.toString()}`,
    });
  }

  // 2) Linked students: use the exact same access-resolution engine as live sync,
  // then repair both missing and obsolete courses in one full profile job.
  const linked = await MoodleLink.find({ role: "student" }).populate("studentRef").limit(limit);
  for (const link of linked) {
    const student = link.studentRef;
    if (!student) {
      report.orphaned += 1;
      await enqueueCoalesced({
        type: "suspendUser",
        payload: { role: "student", id: link.studentRef?._id, suspended: true },
        idempotencyKey: `suspend:student:${link._id}:orphan`,
      });
      continue;
    }
    if (!link.active) continue;
    report.checked += 1;
    const access = await resolveStudentAccess(student);
    if (!access.ok) {
      // Zero Course Protection: never remove existing access when authoritative
      // data cannot currently be resolved. The normal sync records the warning.
      report.noCourses += 1;
      await enqueueCoalesced({
        type: "syncProfile",
        payload: { role: "student", id: student._id.toString() },
        idempotencyKey: `syncProfile:student:${student._id.toString()}`,
      });
      continue;
    }
    const desired = [...new Set(access.courses.map((course) => course.courseId))];
    const held = link.enrolledCourseIds || [];
    const missing = desired.filter((courseId) => !held.includes(courseId));
    const obsolete = held.filter((courseId) => !desired.includes(courseId));
    if (missing.length || obsolete.length) {
      report.enrollmentDrift += 1;
      report.obsoleteEnrollments += obsolete.length;
      await enqueueCoalesced({
        type: "syncProfile",
        payload: { role: "student", id: student._id.toString() },
        idempotencyKey: `syncProfile:student:${student._id.toString()}`,
      });
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
  for (const student of expired) {
    report.suspended += 1;
    await enqueueCoalesced({
      type: "suspendUser",
      payload: { role: "student", id: student._id.toString(), suspended: true },
      idempotencyKey: `suspend:student:${student._id.toString()}`,
    });
  }

  await audit({ action: "RECON_REPAIR", outcome: "success",
    detail: { report, durationMs: Date.now() - started }, createdBy: "reconciliation" });

  logger.info("Moodle reconciliation complete:", report);
  return { ...report, durationMs: Date.now() - started };
}

export default runReconciliation;