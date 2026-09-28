// scripts/diagnose-moodle-push-history.js
//
// READ-ONLY: dump the most recent MoodleAuditLog rows and SyncJob rows so a failed
// class/timetable push is visible instead of silently "missing" from the calendar.
//
// Run: node scripts/diagnose-moodle-push-history.js
import dotenv from "dotenv";
dotenv.config();

import connectDB from "../config/db.js";
import mongoose from "mongoose";
import MoodleAuditLog from "../models/MoodleAuditLog.js";
import SyncJob from "../models/SyncJob.js";
import MoodleLink from "../models/MoodleLink.js";

const line = (s = "") => console.log(s);

async function main() {
  await connectDB();

  line("\n=== Moodle links (who has a Moodle account) ===");
  const links = await MoodleLink.find({}).select("role moodleUserId moodleUsername enrolledCourseIds").lean();
  line(`  ${links.length} link(s)`);
  links.slice(0, 12).forEach((l) => line(`    - ${l.role || "?"} · user ${l.moodleUserId || "?"} · ${l.moodleUsername || "?"} · courses [${(l.enrolledCourseIds || []).join(",")}]`));

  line("\n=== Recent MoodleAuditLog (newest first) ===");
  const logs = await MoodleAuditLog.find({}).sort({ createdAt: -1 }).limit(25).lean();
  if (!logs.length) line("  (none — nothing was ever audited; the push likely never ran)");
  for (const r of logs) {
    line(`  ${new Date(r.createdAt).toISOString()}  ${r.action}  ${r.outcome || ""}`);
    if (r.failure?.message) line(`      FAILURE: ${String(r.failure.message).slice(0, 300)}`);
    if (r.detail?.sessionId) line(`      session ${r.detail.sessionId} -> event ${r.detail.moodleEventId ?? "(none)"} course ${r.detail.moodleCourseId ?? "(site)"}`);
  }

  line("\n=== SyncJob queue (durable retries) ===");
  const jobs = await SyncJob.find({}).sort({ createdAt: -1 }).limit(20).lean();
  if (!jobs.length) line("  (no jobs)");
  for (const j of jobs) {
    line(`  ${new Date(j.createdAt).toISOString()}  ${j.type}  status=${j.status} attempts=${j.attempts ?? 0}/${j.maxAttempts ?? "?"}`);
    if (j.lastError) line(`      lastError: ${String(j.lastError).slice(0, 300)}`);
    if (j.payload?.sessionId) line(`      session ${j.payload.sessionId} action ${j.payload.action || ""}`);
  }

  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  line(`\n  job status counts (recent 20): ${JSON.stringify(byStatus)}`);

  line();
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("\nDiagnostic failed:", err.message);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
