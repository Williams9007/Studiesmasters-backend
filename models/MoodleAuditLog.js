// models/MoodleAuditLog.js
//
// Comprehensive audit trail for every Moodle management action: creation,
// profile sync, enrollment changes, suspension/reactivation, logins, failures.
// Indexed for fast, ad-hoc investigation and dashboard queries.
import mongoose from "mongoose";

const moodleAuditSchema = new mongoose.Schema(
  {
    studentRef: { type: mongoose.Schema.Types.ObjectId, ref: "Student", index: true },
    teacherRef: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", index: true },
    role: { type: String, enum: ["student", "teacher"], default: "student" },
    moodleUserId: { type: Number, default: null },
    moodleUsername: { type: String, default: null },

    action: {
      type: String,
      enum: [
        "ACCOUNT_CREATED",
        "PROFILE_UPDATED",
        "ENROLLMENT_ADDED",
        "ENROLLMENT_REMOVED",
        "SUSPENDED",
        "REACTIVATED",
        "LOGIN_SUCCESS",
        "LOGIN_FAILED",
        "SSO_ISSUED",
        "SSO_REPLAY_REJECTED",
        "SYNC_STARTED",
        "SYNC_COMPLETED",
        "SYNC_FAILED",
        "SYNC_WARNING",
        "RECON_REPAIR",
        "COURSE_ASSIGNED",
      ],
      required: true,
      index: true,
    },

    // Opaque correlation for grouping a full run.
    runId: { type: String, default: null },

    outcome: { type: String, enum: ["success", "failure", "skipped"], default: "success" },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Login-time forensics.
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    device: { type: String, default: null },
    loginAt: { type: Date, default: null },

    createdBy: { type: String, default: "system" },
  },
  { timestamps: true }
);

moodleAuditSchema.index({ studentRef: 1, createdAt: -1 });
moodleAuditSchema.index({ action: 1, createdAt: -1 });

export default mongoose.models.MoodleAuditLog || mongoose.model("MoodleAuditLog", moodleAuditSchema);