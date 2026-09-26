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
const DEFAULT_LEASE_MS = 2 * 60 * 1000;

// Exponential backoff capped at 5 minutes.
export function backoffFor(attempts, base) {
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

/**
 * Enqueue or coalesce a job identified by a stable key.
 * Pending work is left alone. A running job is marked for exactly one fresh run;
 * terminal jobs are reset to pending. This is used for autosync so a burst of
 * website edits becomes one full read-current-state sync.
 */
export async function enqueueCoalesced({ type, payload = {}, idempotencyKey, maxAttempts = 5, backoffMs = 1000 }) {
  if (!idempotencyKey) throw new Error("enqueueCoalesced requires idempotencyKey");
  const created = await enqueue({ type, payload, idempotencyKey, maxAttempts, backoffMs });
  if (!created.duplicate) return { ...created, coalesced: false };

  const job = await SyncJob.findOneAndUpdate(
    { idempotencyKey },
    {
      $set: { payload, type },
      $setOnInsert: { maxAttempts, backoffMs },
    },
    { new: true }
  );
  if (!job) return { ok: false, error: "coalesced Moodle job not found" };

  if (job.status === "in_progress") {
    const marked = await SyncJob.updateOne(
      { _id: job._id, status: "in_progress" },
      { $set: { rerunRequested: true } }
    );
    if (marked.modifiedCount === 1) {
      return { ok: true, duplicate: true, coalesced: true, rerunRequested: true, job };
    }
    // Completion raced this update. Re-read/reset the now-terminal record.
    return enqueueCoalesced({ type, payload, idempotencyKey, maxAttempts, backoffMs });
  }
  if (["succeeded", "failed", "dead_letter"].includes(job.status)) {
    const reset = await SyncJob.findOneAndUpdate(
      { _id: job._id, status: { $in: ["succeeded", "failed", "dead_letter"] } },
      {
        $set: {
          status: "pending", attempts: 0, nextAttemptAt: new Date(), backoffMs,
          lastError: null, rerunRequested: false,
        },
        $unset: { runId: 1, succeededAt: 1, lockedAt: 1, leaseExpiresAt: 1 },
      },
      { new: true }
    );
    if (reset) return { ok: true, duplicate: true, coalesced: true, reset: true, job: reset };
  }
  return { ok: true, duplicate: true, coalesced: true, job };
}

/** Return abandoned in-progress jobs to the pending pool. */
export async function recoverExpiredLeases({ now = new Date() } = {}) {
  const result = await SyncJob.updateMany(
    { status: "in_progress", $or: [
      { leaseExpiresAt: null },
      { leaseExpiresAt: { $ne: null, $lte: now } },
    ] },
    {
      $set: {
        status: "pending",
        nextAttemptAt: now,
        lastError: "Recovered after worker lease expired.",
        rerunRequested: false,
      },
      $unset: { runId: 1, lockedAt: 1, leaseExpiresAt: 1 },
    }
  );
  return result.modifiedCount;
}

// Claim up to `max` due jobs, marking them in_progress with a unique runId.
export async function poll({ max = 10, types = null, maxAttempts = 5, leaseMs = DEFAULT_LEASE_MS } = {}) {
  const now = new Date();
  await recoverExpiredLeases({ now });
  const baseQuery = {
    status: "pending",
    nextAttemptAt: { $lte: now },
    $expr: { $lt: ["$attempts", "$maxAttempts"] },
  };
  if (types && types.length) baseQuery.type = { $in: types };

  const jobs = await SyncJob.find(baseQuery).sort({ nextAttemptAt: 1 }).limit(max).lean();
  const out = [];
  for (const job of jobs) {
    const runId = rand();
    const lockedAt = new Date();
    const res = await SyncJob.updateOne(
      { _id: job._id, status: "pending", nextAttemptAt: { $lte: now } },
      { $set: {
        status: "in_progress", runId, attempts: job.attempts + 1,
        lockedAt, leaseExpiresAt: new Date(lockedAt.getTime() + leaseMs), rerunRequested: false,
      } }
    );
    if (res.modifiedCount === 1) out.push({ ...job, runId, attempts: job.attempts + 1, lockedAt, leaseExpiresAt: new Date(lockedAt.getTime() + leaseMs) });
  }
  return out;
}

export async function complete({ jobId, runId = null, ok, error = null }) {
  try {
    const guard = runId ? { _id: jobId, runId, status: "in_progress" } : { _id: jobId, status: "in_progress" };
    const job = await SyncJob.findOne(guard);
    if (!job) return; // lease was recovered/reassigned; a stale worker must not overwrite it

    if (ok) {
      if (job.rerunRequested) {
        await SyncJob.updateOne(guard, {
          $set: { status: "pending", nextAttemptAt: new Date(), rerunRequested: false, lastError: null },
          $unset: { runId: 1, lockedAt: 1, leaseExpiresAt: 1, succeededAt: 1 },
        });
      } else {
        await SyncJob.updateOne(guard, {
          $set: { status: "succeeded", succeededAt: new Date(), lastError: null, rerunRequested: false },
          $unset: { runId: 1, lockedAt: 1, leaseExpiresAt: 1 },
        });
      }
      return;
    }
    const freshRunRequested = !!job.rerunRequested;
    const isDead = job.attempts >= job.maxAttempts && !freshRunRequested;
    const effectiveAttempts = freshRunRequested ? 0 : job.attempts;
    const next = new Date(Date.now() + (isDead ? 0 : backoffFor(effectiveAttempts, job.backoffMs)));
    await SyncJob.updateOne(
      guard,
      {
        $set: {
          status: isDead ? "dead_letter" : "pending",
          attempts: freshRunRequested ? 0 : job.attempts,
          lastError: error ? String(error).slice(0, 1000) : null,
          nextAttemptAt: isDead ? null : next,
          backoffMs: isDead ? job.backoffMs : backoffFor(effectiveAttempts, job.backoffMs),
          rerunRequested: false,
        },
        $unset: { runId: 1, lockedAt: 1, leaseExpiresAt: 1 },
      }
    );
  } catch (err) {
    logger.error("queue.complete failed:", err.message);
  }
}

export default { enqueue, enqueueCoalesced, recoverExpiredLeases, poll, complete };
