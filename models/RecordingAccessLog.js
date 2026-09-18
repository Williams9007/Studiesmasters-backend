// models/RecordingAccessLog.js
//
// Logs every access attempt to recordings for security auditing.
// Tracks who watched what, when, from where, and whether access was granted.

import mongoose from "mongoose";

const recordingAccessLogSchema = new mongoose.Schema(
  {
    // Reference to the ClassSession being accessed
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClassSession",
      required: true,
      index: true,
    },
    
    // User attempting to access
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    
    // User role at time of access
    role: {
      type: String,
      enum: ["student", "teacher", "qao", "admin"],
      required: true,
    },
    
    // Action attempted
    action: {
      type: String,
      enum: ["view", "download_attempt", "play", "denied", "expired_url"],
      required: true,
      index: true,
    },
    
    // Whether access was granted
    granted: {
      type: Boolean,
      required: true,
      index: true,
    },
    
    // Reason if access denied
    denialReason: {
      type: String,
      trim: true,
      default: "",
    },
    
    // Session metadata at time of access
    sessionInfo: {
      subject: { type: String, trim: true, default: "" },
      grade: { type: String, trim: true, default: "" },
      teacherName: { type: String, trim: true, default: "" },
    },
    
    // Request metadata
    ip: {
      type: String,
      trim: true,
      default: "",
    },
    
    userAgent: {
      type: String,
      trim: true,
      default: "",
    },
    
    deviceInfo: {
      browser: { type: String, trim: true, default: "" },
      os: { type: String, trim: true, default: "" },
    },
    
    // URL parameters (for debugging/token validation)
    urlExpiresAt: {
      type: Date,
      default: null,
    },
    
    // Whether a fresh URL was generated
    urlGenerated: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for common queries
recordingAccessLogSchema.index({ sessionId: 1, createdAt: -1 });
recordingAccessLogSchema.index({ userId: 1, createdAt: -1 });
recordingAccessLogSchema.index({ action: 1, granted: 1 });
recordingAccessLogSchema.index({ createdAt: -1 });

// TTL index: auto-delete logs older than 1 year (adjust as needed)
// Uncomment when ready: recordingAccessLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 });

/**
 * Extract device info from user agent string
 */
function parseUserAgent(ua) {
  if (!ua) return { browser: "", os: "" };
  
  let browser = "";
  let os = "";
  
  // Simple parsing (could use ua-parser-js for more accuracy)
  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Safari") && !ua.includes("Chrome")) browser = "Safari";
  else if (ua.includes("Edge")) browser = "Edge";
  
  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iOS") || ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  
  return { browser, os };
}

/**
 * Log a recording access attempt
 */
export async function logAccess({
  sessionId,
  userId,
  role,
  action,
  granted,
  denialReason = "",
  sessionInfo = {},
  req = null,
  urlExpiresAt = null,
  urlGenerated = false,
} = {}) {
  const ip = req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || 
              req?.connection?.remoteAddress || "";
  const userAgent = req?.headers?.["user-agent"] || "";
  const deviceInfo = parseUserAgent(userAgent);

  const log = new RecordingAccessLog({
    sessionId,
    userId,
    role,
    action,
    granted,
    denialReason,
    sessionInfo,
    ip,
    userAgent,
    deviceInfo,
    urlExpiresAt,
    urlGenerated,
  });

  await log.save();
  return log;
}

/**
 * Get access logs for a session
 */
export async function getSessionAccessLogs(sessionId, limit = 50) {
  return RecordingAccessLog.find({ sessionId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Get access logs for a user
 */
export async function getUserAccessLogs(userId, limit = 50) {
  return RecordingAccessLog.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/**
 * Get denied access attempts (security monitoring)
 */
export async function getDeniedAccessLogs(limit = 100, since = null) {
  const query = { granted: false };
  if (since) query.createdAt = { $gte: since };
  
  return RecordingAccessLog.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

const RecordingAccessLog = mongoose.models.RecordingAccessLog || 
                          mongoose.model("RecordingAccessLog", recordingAccessLogSchema);

export default RecordingAccessLog;