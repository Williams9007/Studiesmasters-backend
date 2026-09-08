import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    // Backwards-compatible admin references (existing admin flow)
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    adminEmail: { type: String, default: null },

    // Generic actor for non-admin roles (QaoUser, Teacher). Populate refPath.
    actor: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorRole: { type: String, enum: ["qao", "teacher", "student", "admin"], default: null },
    actorEmail: { type: String, default: null },

    action: { type: String, required: true },
    resource: { type: String, default: null },
    resourceId: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    success: { type: Boolean, default: true },
    method: { type: String, default: null },
    path: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ admin: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, action: 1 });
auditLogSchema.index({ action: 1 });
auditLogSchema.index({ actorRole: 1, createdAt: -1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);
export default AuditLog;