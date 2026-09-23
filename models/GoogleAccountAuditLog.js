// models/GoogleAccountAuditLog.js
//
// Audit log for teacher Google account changes (Phase 6E Enhanced).
// Required for education platform security compliance.
//
// Tracks:
//   - Google account connected/disconnected
//   - Email changes
//   - Admin overrides
//   - Verification failures
//
// This collection provides a complete audit trail for:
//   - Security investigations
//   - Compliance requirements
//   - Troubleshooting co-host issues
//   - Teacher account lifecycle management

import mongoose from "mongoose";

const googleAccountAuditSchema = new mongoose.Schema(
  {
    // The teacher whose Google account was affected
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Teacher",
      required: true,
      index: true,
    },

    // The action that was performed
    action: {
      type: String,
      enum: [
        // Connection actions
        "google_connected",
        "google_disconnected",
        "google_verified",
        "google_verification_failed",

        // Email changes
        "google_email_changed",
        "google_email_admin_set",

        // Admin actions
        "admin_override",
        "admin_reassigned",

        // System actions
        "system_sync",
        "meeting_created",
        "meeting_attendee_updated",
      ],
      required: true,
      index: true,
    },

    // The Google email involved in this action
    googleEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    // The previous Google email (for change tracking)
    previousGoogleEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    // Who performed the action
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Teacher",
      default: null,
      index: true,
    },

    // Role of the performer (for cases where performer isn't a teacher)
    performerRole: {
      type: String,
      enum: ["teacher", "admin", "qao", "system", "google", null],
      default: null,
    },

    // IP address of the request (for security auditing)
    ipAddress: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },

    // User agent string (for security auditing)
    userAgent: {
      type: String,
      trim: true,
      default: null,
    },

    // Session ID for traceability
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClassSession",
      default: null,
    },

    // Additional details about the action (structured data)
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Error message if the action failed
    errorMessage: {
      type: String,
      trim: true,
      default: null,
    },

    // Whether the action was successful
    success: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for common queries
googleAccountAuditSchema.index({ teacherId: 1, createdAt: -1 });
googleAccountAuditSchema.index({ action: 1, createdAt: -1 });
googleAccountAuditSchema.index({ success: 1, createdAt: -1 });
googleAccountAuditSchema.index({ ipAddress: 1, createdAt: -1 });

// Static methods for common audit operations
googleAccountAuditSchema.statics.logConnection = async function ({
  teacherId,
  googleEmail,
  performedBy,
  ipAddress,
  userAgent,
  sessionId = null,
  details = {},
  success = true,
  errorMessage = null,
}) {
  return this.create({
    teacherId,
    action: success ? "google_connected" : "google_verification_failed",
    googleEmail,
    performedBy,
    ipAddress,
    userAgent,
    sessionId,
    details,
    success,
    errorMessage,
  });
};

export default mongoose.models.GoogleAccountAuditLog ||
  mongoose.model("GoogleAccountAuditLog", googleAccountAuditSchema);