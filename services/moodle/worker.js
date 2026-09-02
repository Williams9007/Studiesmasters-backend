// services/moodle/worker.js
//
// Durable queue consumer. Picks up pending SyncJobs, dispatches to the
// appropriate service, and records outcomes (success / retry / dead-letter).
// Runs as an interval inside the API process (stateless, horizontally scalabale)
// so multiple instances can share the Mongo-backed queue.

import { poll, complete } from "./queue.js";
import { createUser } from "./createUser.js";
import { updateUser } from "./updateUser.js";
import { enrollUser } from "./enrollUser.js";
import { unenrollUser } from "./unenrollUser.js";
import { suspendUser } from "./suspendUser.js";
import { syncProfile } from "./syncProfile.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";

const HANDLERS = {
  createUser: (p) => createUser({ role: p.role, id: p.id, email: p.email, fullName: p.fullName, userId: p.userId }),
  updateUser: (p) => updateUser({ role: p.role, id: p.id, email: p.email, fullName: p.fullName }),
  syncProfile: (p) => syncProfile({ id: p.id, role: p.role }),
  enrollUser: (p) => enrollUser({ role: p.role || "student", id: p.id, courseIds: p.courseIds, subjects: p.subjects, curriculum: p.curriculum, packageName: p.packageName, grade: p.grade }),
  unenrollUser: (p) => unenrollUser({ role: p.role, id: p.id, courseIds: p.courseIds }),
  suspendUser: (p) => suspendUser({ role: p.role || "student", id: p.id, suspended: !!p.suspended }),
  reactivateUser: (p) => suspendUser({ role: p.role || "student", id: p.id, suspended: false }),
  assignCourse: (p) => enrollUser({ role: p.role || "student", id: p.id, courseIds: p.courseIds || [p.courseId] }),
};

export async function processQueueBatch({ max = 10 } = {}) {
  const jobs = await poll({ max });
  for (const job of jobs) {
    try {
      const handler = HANDLERS[job.type];
      if (!handler) throw new Error(`no handler for job type ${job.type}`);
      await handler(job.payload || {});
      await complete({ jobId: job._id, ok: true });
      await audit({ action: "SYNC_COMPLETED", outcome: "success",
        detail: { type: job.type }, runId: job.runId, createdBy: "worker" });
    } catch (err) {
      if (job.attempts >= job.maxAttempts) {
        await audit({ action: "SYNC_FAILED", outcome: "failure",
          failure: err.message, detail: { type: job.type, attempts: job.attempts }, runId: job.runId, createdBy: "worker" });
      }
      await complete({ jobId: job._id, ok: false, error: err.message });
    }
  }
  return jobs.length;
}

export function startWorker({ intervalMs = 2000, enabled = true } = {}) {
  if (!enabled) return { stop: () => {} };
  const timer = setInterval(() => processQueueBatch({ max: 10 }).catch((e) => logger.error("Worker loop error:", e.message)), intervalMs);
  logger.info(`Moodle queue worker started (every ${intervalMs}ms)`);
  return { stop: () => clearInterval(timer) };
}

export default { processQueueBatch, startWorker };