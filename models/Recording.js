// models/Recording.js
// Dedicated Recording model - separates recording data from ClassSession
import crypto from "crypto";
import mongoose from "mongoose";

const recordingSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClassSession",
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "available", "failed", "archived"],
      default: "pending",
      index: true,
    },
    driveFileId: { type: String, trim: true, default: "" },
    driveFolderId: { type: String, trim: true, default: "" },
    driveFileName: { type: String, trim: true, default: "" },
    driveMimeType: { type: String, trim: true, default: "" },
    driveFileSize: { type: Number, default: 0 },
    streamUrl: { type: String, trim: true, default: "" },
    thumbnailUrl: { type: String, trim: true, default: "" },
    durationMinutes: { type: Number, default: 0 },
    fileSizeBytes: { type: Number, default: 0 },
    downloadAllowed: { type: Boolean, default: false },
    available: { type: Boolean, default: false },
    uploadedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    errorMessage: { type: String, trim: true, default: "" },
    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date, default: null },
    
    // Moodle mapping
    moodleCourseId: { type: Number, default: null },
    moodleSectionId: { type: Number, default: null },
    moodleResourceId: { type: String, trim: true, default: "" },
    moodleSyncStatus: {
      type: String,
      enum: ["pending", "synced", "failed", "not_configured"],
      default: "pending",
    },
    moodleSyncedAt: { type: Date, default: null },
    moodleErrorMessage: { type: String, trim: true, default: "" },
    
    // Token-based streaming security
    token: {
      currentTokenId: { type: String, trim: true, default: "" },
      tokenHash: { type: String, trim: true, default: "" },
      tokenExpiresAt: { type: Date, default: null },
      tokenIssuedAt: { type: Date, default: null },
      tokenUsed: { type: Boolean, default: false },
      tokenUsedAt: { type: Date, default: null },
      tokenUsedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
      tokenUses: { type: Number, default: 0 },
      maxTokenUses: { type: Number, default: 1 },
    },
    
    // Access control
    accessLevel: {
      requiresEnrollment: { type: Boolean, default: true },
      allowedRoles: {
        type: [String],
        enum: ["student", "teacher", "qao", "admin"],
        default: ["student", "teacher", "qao", "admin"],
      },
    },
    
    // AI-ready fields
    ai: {
      transcript: { type: String, trim: true, default: "" },
      transcriptStatus: {
        type: String,
        enum: ["pending", "processing", "available", "failed"],
        default: "pending",
      },
      summary: { type: String, trim: true, default: "" },
      summaryStatus: {
        type: String,
        enum: ["pending", "processing", "available", "failed"],
        default: "pending",
      },
      keywords: [{ type: String, trim: true }],
      chapters: [{
        title: { type: String, trim: true },
        timestamp: { type: Number },
        duration: { type: Number },
      }],
      generatedQuizzes: [{
        question: { type: String, trim: true },
        type: { type: String, enum: ["multiple-choice", "short-answer", "essay"], default: "multiple-choice" },
        options: [{ type: String, trim: true }],
        correctAnswer: { type: String, trim: true },
      }],
      flashcards: [{
        front: { type: String, trim: true },
        back: { type: String, trim: true },
        topic: { type: String, trim: true },
      }],
    },
    
    // Analytics
    analytics: {
      totalViews: { type: Number, default: 0 },
      uniqueViewers: { type: Number, default: 0 },
      totalWatchTimeSeconds: { type: Number, default: 0 },
      avgCompletionPercentage: { type: Number, default: 0 },
      lastViewedAt: { type: Date, default: null },
    },
    
    version: { type: Number, default: 1 },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// ---- Indexes ---------------------------------------------------------------
// Worker sweep: still-unfinished recordings, oldest first.
recordingSchema.index({ status: 1, createdAt: -1 });

// ---- Virtuals --------------------------------------------------------------
// Playable only when the file exists on Drive AND a stream URL was built —
// matches the guard in services/recording/recording.service.js#getSecureStreamUrl.
recordingSchema.virtual("isStreamable").get(function () {
  return Boolean(this.available && this.driveFileId && this.streamUrl);
});

// ---- Instance methods ------------------------------------------------------
/**
 * Issue a short-lived streaming token for this recording.
 *
 * The RAW token is returned to the caller so it can be embedded in the stream
 * URL; only its SHA-256 hash is persisted (same convention as
 * utils/passwordReset.js), so a database leak cannot be replayed against the
 * stream endpoint.
 *
 * @param {number} maxUses    How many times the token may be consumed (default 1).
 * @param {number} validHours How long the token stays valid, in hours (default 2).
 * @returns {string} raw token to put in the stream URL.
 */
recordingSchema.methods.generateToken = function (maxUses = 1, validHours = 2) {
  const raw = crypto.randomBytes(32).toString("hex");
  const uses = Number(maxUses) > 0 ? Math.floor(Number(maxUses)) : 1;
  const hours = Number(validHours) > 0 ? Number(validHours) : 2;

  if (!this.token) this.token = {};
  this.token.currentTokenId = crypto.randomBytes(8).toString("hex");
  this.token.tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  this.token.tokenIssuedAt = new Date();
  this.token.tokenExpiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  this.token.tokenUsed = false;
  this.token.tokenUsedAt = null;
  this.token.tokenUsedBy = null;
  this.token.tokenUses = 0;
  this.token.maxTokenUses = uses;

  return raw;
};

// ---- Statics ---------------------------------------------------------------
// Give up after this many failed detection attempts (markRecordingFailed()
// bumps retryCount on every failure).
const MAX_PROCESSING_ATTEMPTS = 5;

/**
 * Recordings that still need detection/processing, oldest first.
 * Used by services/recording/recording.service.js#processPendingRecordings()
 * and workers/recording.worker.js.
 */
recordingSchema.statics.findPendingProcessing = function (limit = 50) {
  const max = Number(limit) > 0 ? Number(limit) : 50;
  return this.find({
    status: { $in: ["pending", "processing", "failed"] },
    retryCount: { $lt: MAX_PROCESSING_ATTEMPTS },
  })
    .sort({ createdAt: 1 })
    .limit(max);
};

const Recording =
  mongoose.models.Recording || mongoose.model("Recording", recordingSchema);

export default Recording;