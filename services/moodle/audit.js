// services/moodle/audit.js
//
// Unified audit writer for all Moodle management events. Writes to MongoDB
// (MoodleAuditLog) and always mirrors to the app logger. Never throws — audit
// failures must not break management flows.
import MoodleAuditLog from "../../models/MoodleAuditLog.js";
import logger from "../../utils/logger.js";
import { config } from "./config.js";

const LEVELS = ["info", "warn", "error"];

export async function audit({ action, studentRef, teacherRef, role, moodleUserId, moodleUsername,
  runId, outcome = "success", failure = null, detail = {}, req = null, createdBy = "system" }) {
  const entry = {
    action,
    studentRef: studentRef || null,
    teacherRef: teacherRef || null,
    role: role || "student",
    moodleUserId: moodleUserId ?? null,
    moodleUsername: moodleUsername || null,
    runId: runId || null,
    outcome,
    failure: typeof failure === "string" ? { message: failure } : failure || {},
    ip: req?.ip || req?.socket?.remoteAddress || null,
    userAgent: req?.headers?.["user-agent"] || null,
    device: req?.headers?.["sec-ch-ua-platform"] || null,
    loginAt: action?.startsWith("LOGIN") ? new Date() : null,
    createdBy,
    detail: detail,
  };
  // Preserve extra caller-supplied detail.
  if (detail && typeof detail === "object") Object.assign(entry, { detail });

  const level = outcome === "failure" ? "error" : "info";
  logger[LEVELS.includes(level) ? level : "info"](`[MOODLE] ${action} ${outcome}`,
    { student: studentRef, moodleUserId, runId, failure });

  if (config.auditToDb) {
    try {
      await MoodleAuditLog.create(entry);
    } catch (err) {
      logger.error("Moodle audit DB write failed:", err.message);
    }
  }
  return entry;
}

export default audit;