// services/moodle/syncStatus.js
//
// Moodle sync status tracking + admin warning system + dashboard overview.
// Every sync attempt records its outcome on the student (moodleSyncStatus) and
// every warning is mirrored to the audit trail so admins can act on it.

import Student from "../../models/Student.js";
import SyncJob from "../../models/SyncJob.js";
import CourseMapping from "../../models/CourseMapping.js";
import { audit } from "./audit.js";
import logger from "../../utils/logger.js";

const STATUSES = ["PENDING", "SYNCING", "SYNCED", "WARNING", "FAILED", "NO_COURSES_FOUND"];
export const SYNC_STATUSES = STATUSES;

/** Persist a sync outcome for a student and audit any warnings. */
export async function recordSyncStatus(studentId, {
  status,
  coursesAssigned = 0,
  error = null,
  warnings = [],
  runId = null,
  moodleUserId = null,
}) {
  if (!STATUSES.includes(status)) status = "FAILED";
  const now = new Date();
  const pushWarnings = (warnings || []).map((w) => ({
    code: String(w.code || w || "WARNING").slice(0, 80),
    message: String(w.message || w || "Moodle sync warning").slice(0, 500),
    at: now,
  }));

  const set = {
    "moodleSyncStatus.status": status,
    "moodleSyncStatus.coursesAssigned": coursesAssigned,
    "moodleSyncStatus.lastSync": now,
    "moodleSyncStatus.lastError": error,
  };
  if (status === "SYNCED" || status === "WARNING") set["moodleSyncStatus.syncedAt"] = now;

  const student = await Student.findByIdAndUpdate(
    studentId,
    {
      $set: set,
      ...(pushWarnings.length ? { $push: { "moodleSyncStatus.warnings": { $each: pushWarnings, $position: 0, $slice: 25 } } } : {}),
    },
    { new: true, projection: { moodleSyncStatus: 1, fullName: 1, selectedPlan: 1, package: 1, curriculum: 1, grade: 1 } }
  );

  // Admin warning system — every warning surfaces in the dashboard + audit log.
  for (const w of pushWarnings) {
    logger.warn(`[MOODLE] Sync warning for student ${studentId}: [${w.code}] ${w.message}`);
    await audit({
      action: "SYNC_WARNING",
      studentRef: studentId,
      moodleUserId,
      runId,
      outcome: "failure",
      failure: { message: w.message },
      detail: { warningCode: w.code, status },
      createdBy: "accessResolver",
    }).catch(() => {});
  }
  return student;
}

/** Admin dashboard overview: sync-status counts + queue + mapping health. */
/** Admin dashboard overview: sync-status counts + queue + mapping health. */
export async function syncOverview() {
  const [statusCounts, queue, mappings, missingMappings, lastSync] = await Promise.all([
    Student.aggregate([{ $group: { _id: "$moodleSyncStatus.status", count: { $sum: 1 } } }]),
    queueSnapshotSafe(),
    CourseMapping.countDocuments({ enabled: true }),
    CourseMapping.find({ enabled: true, "targets.0": { $exists: false } }).limit(5).lean(),
    Student.findOne({ "moodleSyncStatus.syncedAt": { $ne: null } })
      .sort({ "moodleSyncStatus.syncedAt": -1 })
      .select("moodleSyncStatus.syncedAt").lean(),
  ]);

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let totalStudents = 0;
  for (const row of statusCounts) {
    const key = row._id || "PENDING";
    byStatus[key] = row.count;
    totalStudents += row.count;
  }

  return {
    totalStudents,
    studentsSynced: byStatus.SYNCED + byStatus.WARNING,
    studentsWithoutCourses: byStatus.NO_COURSES_FOUND,
    failedSyncs: byStatus.FAILED,
    successfulSyncs: byStatus.SYNCED,
    byStatus,
    lastSynchronization: lastSync?.moodleSyncStatus?.syncedAt || queue.lastSynchronization || null,
    queue,
    courseMapping: {
      enabled: mappings,
      empty: missingMappings.length,
      details: missingMappings.map((m) => ({ id: m._id, subjectName: m.subjectName, curriculum: m.curriculum, grade: m.grade })),
    },
  };
}

async function queueSnapshotSafe() {
  try {
    const [pending, inProgress, failed, deadLetter, succeeded, recentErrors] = await Promise.all([
      SyncJob.countDocuments({ status: "pending" }),
      SyncJob.countDocuments({ status: "in_progress" }),
      SyncJob.countDocuments({ status: "failed" }),
      SyncJob.countDocuments({ status: "dead_letter" }),
      SyncJob.countDocuments({ status: "succeeded" }),
      SyncJob.find({ lastError: { $ne: null } }).sort({ updatedAt: -1 }).limit(5)
        .select("type status attempts lastError updatedAt").lean(),
    ]);
    const last = await SyncJob.findOne({ status: "succeeded" }).sort({ succeededAt: -1 }).select("succeededAt").lean();
    return { pending, inProgress, failed, deadLetter, succeeded, lastSynchronization: last?.succeededAt || null, recentErrors };
  } catch (err) {
    logger.error("syncOverview queue snapshot failed:", err.message);
    return { pending: 0, inProgress: 0, failed: 0, deadLetter: 0, succeeded: 0, recentErrors: [], lastSynchronization: null };
  }
}

/** Students needing admin attention (warnings / no courses / failures). */
export async function listWarnings({ limit = 50 } = {}) {
  const students = await Student.find({
    "moodleSyncStatus.status": { $in: ["NO_COURSES_FOUND", "FAILED", "WARNING"] },
  })
    .select("fullName userId email curriculum grade package selectedPlan subjectNames moodleSyncStatus")
    .sort({ "moodleSyncStatus.lastSync": -1 })
    .limit(limit)
    .lean();

  return students.map((s) => ({
    studentId: s._id,
    name: s.fullName,
    userId: s.userId,
    email: s.email,
    curriculum: s.curriculum,
    grade: s.grade,
    package: s.selectedPlan || s.package,
    subjects: s.subjectNames,
    status: s.moodleSyncStatus?.status,
    coursesAssigned: s.moodleSyncStatus?.coursesAssigned ?? 0,
    lastError: s.moodleSyncStatus?.lastError || null,
    lastSync: s.moodleSyncStatus?.lastSync || null,
    warnings: s.moodleSyncStatus?.warnings?.slice(0, 5) || [],
  }));
}

/** Requeue every failed / dead-letter sync job (admin "Retry Failed Syncs"). */
export async function retryFailedSyncs() {
  const res = await SyncJob.updateMany(
    { status: { $in: ["failed", "dead_letter"] } },
    { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), backoffMs: 1000, lastError: null }, $unset: { runId: 1, succeededAt: 1 } }
  );
  logger.info(`Retry-failed-syncs: requeued ${res.modifiedCount} jobs`);
  return { ok: true, requeued: res.modifiedCount };
}

export default { recordSyncStatus, syncOverview, listWarnings, retryFailedSyncs, SYNC_STATUSES };
