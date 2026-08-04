import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    adminEmail: { type: String, default: null },
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
auditLogSchema.index({ action: 1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);
export default AuditLog;