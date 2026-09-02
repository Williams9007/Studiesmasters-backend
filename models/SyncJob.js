// models/SyncJob.js
//
// Mongo-backed durable queue for asynchronous Moodle synchronization + repair
// jobs. Per-job state machine: pending -> in_progress -> succeeded | failed
// (with attempt/backoff) -> dead (dead-letter after MAX_ATTEMPTS).
//
// This keeps the architecture queue-based and horizontally scalable without a
// broker; it can be swapped behind the same interface for BullMQ later.
import mongoose from "mongoose";

const syncJobSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "createUser",
        "updateUser",
        "syncProfile",
        "enrollUser",
        "unenrollUser",
        "suspendUser",
        "reactivateUser",
        "assignCourse",
        "reconcile",
        "custom",
      ],
      required: true,
      index: true,
    },
    // Payload describing the target and what to do. Contains volatile identity,
    // never secrets.
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ["pending", "in_progress", "succeeded", "failed", "dead_letter"],
      default: "pending",
      index: true,
    },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: null },
    backoffMs: { type: Number, default: 1000 },

    lastError: { type: String, default: null },
    succeededAt: { type: Date, default: null },
    runId: { type: String, default: null },

    // Idempotency key — prevents duplicate account creation / duplicate jobs.
    idempotencyKey: { type: String, unique: true, sparse: true, index: true },
  },
  { timestamps: true }
);

syncJobSchema.index({ status: 1, nextAttemptAt: 1 });

export default mongoose.models.SyncJob || mongoose.model("SyncJob", syncJobSchema);