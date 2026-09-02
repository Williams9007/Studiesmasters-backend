// services/moodle/bulkSync.js
//
// Admin-triggered bulk operations:
//   syncAllStudents() -> enqueues a durable syncProfile SyncJob for every
//                        student (idempotent, retrying, never lost). The
//                        worker performs create/update/enroll/unenroll per
//                        student, so a Moodle outage loses nothing.
//   queueSnapshot()   -> pending / in-progress / failed / dead-letter counts
//                        plus the most recent errors, for the admin dashboard.

import Student from "../../models/Student.js";
import SyncJob from "../../models/SyncJob.js";
import { enqueue } from "./queue.js";
import logger from "../../utils/logger.js";

export async function syncAllStudents({ limit = 500 } = {}) {
  const students = await Student.find({}).select("_id").limit(limit).lean();
  let enqueued = 0;
  let duplicates = 0;
  let reset = 0;

  for (const s of students) {
    const idempotencyKey = `syncProfile:${s._id.toString()}`;
    const result = await enqueue({
      type: "syncProfile",
      payload: { id: s._id.toString(), role: "student" },
      idempotencyKey,
    });
    if (result.duplicate) {
      // Job already exists — if it already ran (succeeded/failed/dead) reset it
      // back to pending so a manual "Sync All" always forces a fresh pass.
      const updated = await SyncJob.updateOne(
        { idempotencyKey, status: { $in: ["succeeded", "failed", "dead_letter"] } },
        { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null }, $unset: { runId: 1, succeededAt: 1 } }
      );
      if (updated.modifiedCount) reset += 1; else duplicates += 1;
    } else if (result.ok) {
      enqueued += 1;
    }
  }

  const report = { ok: true, students: students.length, enqueued, reset, alreadyQueued: duplicates };
  logger.info("Bulk student sync enqueued:", report);
  return report;
}

export async function queueSnapshot() {
  const [pending, inProgress, failed, deadLetter, succeeded, recentErrors, recentJobs] = await Promise.all([
    SyncJob.countDocuments({ status: "pending" }),
    SyncJob.countDocuments({ status: "in_progress" }),
    SyncJob.countDocuments({ status: "pending", attempts: { $gt: 0 } }),
    SyncJob.countDocuments({ status: "dead_letter" }),
    SyncJob.countDocuments({ status: "succeeded" }),
    SyncJob.find({ lastError: { $ne: null } }).sort({ updatedAt: -1 }).limit(10)
      .select("type status attempts lastError updatedAt payload").lean(),
    SyncJob.find({}).sort({ updatedAt: -1 }).limit(10)
      .select("type status attempts lastError updatedAt").lean(),
  ]);
  const last = await SyncJob.findOne({ status: "succeeded" }).sort({ succeededAt: -1 }).select("succeededAt").lean();
  return {
    pending, inProgress, failed, deadLetter, succeeded,
    lastSynchronization: last?.succeededAt || null,
    recentErrors,
    recentJobs,
  };
}

export default { syncAllStudents, queueSnapshot };
