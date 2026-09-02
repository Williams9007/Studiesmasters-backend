// services/moodle/queue.js
//
// Mongo-backed durable job queue for asynchronous Moodle operations.
//
//   enqueue(type, payload, opts)  -> creates a pending SyncJob (idempotency-aware)
//   claimNext(max)                -> atomically claims due jobs for a worker
//   complete(runId, ok, err)      -> mark succeeded / schedule retry / dead-letter
//
// Retry: exponential backoff capped at MAX attempts; repeated failures dead-letter
// the job. Idempotency keys prevent duplicate account creation and duplicate jobs.
import SyncJob from "../../models/SyncJob.js";
import crypto from "crypto";
import logger from "../../utils/logger.js";

const rand = () => crypto.randomBytes(12).toString("hex");

// Exponential backoff capped at 5 minutes.
function backoffFor(attempts, base) {
  const capped = Math.min(attempts, 8);
  return Math.min(base * 2 ** capped, 300000);
}

export async function enqueue({ type, payload = {}, idempotencyKey = null, maxAttempts = 5, backoffMs = 1000 }) {
  const key = idempotencyKey || `${type}:${rand()}`;
  try {
    const job = await SyncJob.create({
      type,
      payload,
      status: "pending",
      attempts: 0,
      maxAttempts,
      backoffMs,
      nextAttemptAt: new Date(),
      idempotencyKey: key,
    });
    logger.info("Moodle job enqueued:", type, job._id.toString());
    return { ok: true, job };
  } catch (err) {
    // Duplicate idempotencyKey -> already queued; return it as a no-op success.
    if (err?.code === 11000) {
      logger.warn("Moodle job duplicate (idempotencyKey) ignored:", key);
      return { ok: true, duplicate: true };
    }
    logger.error("Moodle job enqueue failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// Claim up to `max` due jobs, marking them in_progress with a unique runId.
export async function poll({ max = 10, types = null, maxAttempts = 5 } = {}) {
  const now = new Date();
  const baseQuery = {
    status: "pending",
    nextAttemptAt: { $lte: now },
    $expr: { $lt: ["$attempts", "$maxAttempts"] },
  };
  if (types && types.length) baseQuery.type = { $in: types };

  const jobs = await SyncJob.find(baseQuery).limit(max).lean();
  const out = [];
  for (const job of jobs) {
    const runId = rand();
    const res = await SyncJob.updateOne(
      { _id: job._id, status: "pending", nextAttemptAt: { $lte: now } },
      { $set: { status: "in_progress", runId, attempts: job.attempts + 1 } }
    );
    if (res.modifiedCount === 1) out.push({ ...job, runId, attempts: job.attempts + 1 });
  }
  return out;
}

export async function complete({ jobId, ok, error = null }) {
  try {
    if (ok) {
      await SyncJob.updateOne({ _id: jobId }, { $set: { status: "succeeded", succeededAt: new Date(), lastError: null } });
      return;
    }
    const job = await SyncJob.findById(jobId);
    if (!job) return;
    const isDead = job.attempts >= job.maxAttempts;
    const next = new Date(Date.now() + (isDead ? 0 : backoffFor(job.attempts, job.backoffMs)));
    await SyncJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: isDead ? "dead_letter" : "pending",
          lastError: error ? String(error).slice(0, 1000) : null,
          nextAttemptAt: isDead ? null : next,
          backoffMs: isDead ? job.backoffMs : backoffFor(job.attempts, job.backoffMs),
        },
        $unset: { runId: 1 },
      }
    );
  } catch (err) {
    logger.error("queue.complete failed:", err.message);
  }
}

export default { enqueue, poll, complete };