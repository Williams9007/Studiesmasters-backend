// scripts/verify-class-moodle-sync.js
//
// LIVE verification (writes to Moodle, idempotent) of the "scheduled classes +
// Meet links reach Moodle" fix:
//   * re-generates any missing Google Meet link and pushes it to Moodle
//   * re-pushes every scheduled class to its mapped Moodle COURSE calendar
//   * persists moodleEventId / moodleCourseId back onto each session
// It uses exactly the same service functions the admin repair endpoints call, so
// a green result here means POST /api/admin/sessions/backfill-meetings works.
//
// Run: node scripts/verify-class-moodle-sync.js
import dotenv from "dotenv";
dotenv.config();

import connectDB from "../config/db.js";
import mongoose from "mongoose";
import ClassSession from "../models/ClassSession.js";
import ClassGroup from "../models/ClassGroup.js";
import Teacher from "../models/teacher.js";
import { backfillPendingMeetings, resyncAllClassSessionsToMoodle } from "../services/qao/scheduling.service.js";

const line = (s = "") => console.log(s);
let failures = 0;
const ok = (label) => line(`  PASS  ${label}`);
const no = (label, detail = "") => { failures++; line(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`); };
const check = (label, cond, detail) => (cond ? ok(label) : no(label, detail));

async function main() {
  await connectDB();

  line("\n[1] Backfill any missing Google Meet link");
  const before = await ClassSession.countDocuments({
    status: { $in: ["scheduled", "live"] },
    meetingStatus: { $ne: "ready" },
  });
  line(`    sessions not ready before: ${before}`);
  const backfill = await backfillPendingMeetings({ limit: 50 });
  line(`    backfill -> ${JSON.stringify(backfill)}`);
  check("backfill completed without errors", backfill.failed === 0, JSON.stringify(backfill.errors));

  line("\n[2] Re-push every scheduled class to its Moodle COURSE calendar");
  const resync = await resyncAllClassSessionsToMoodle();
  line(`    resync -> ${JSON.stringify(resync)}`);
  check("all scheduled classes pushed", resync.failed === 0, `failed=${resync.failed}`);

  line("\n[3] Verify each session now has a Meet link, a Moodle event id and a course");
  const sessions = await ClassSession.find({ status: { $in: ["scheduled", "live"] } })
    .populate("classGroup", "code subject grade curriculum")
    .populate("teacher", "fullName")
    .lean();
  check("scheduled/live sessions exist", sessions.length > 0, `count=${sessions.length}`);
  for (const s of sessions) {
    const g = s.classGroup || {};
    const label = `${String(s.date).slice(0, 10)} ${s.startTime} ${g.code || "?"} ${g.subject || ""}`;
    check(`${label} has a Google Meet link`, Boolean(s.meetingLink), "meetingLink is empty");
    check(`${label} has moodleEventId`, Boolean(s.moodleEventId), "moodleEventId not persisted");
    check(`${label} landed on a COURSE (not a site event)`, Boolean(s.moodleCourseId), "moodleCourseId is null");
  }

  line(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===\n`);
  await mongoose.connection.close();
  process.exitCode = failures ? 1 : 0;
}

main().catch(async (err) => {
  console.error("\nVerification failed:", err.message);
  console.error(err.stack?.split("\n").slice(0, 6).join("\n"));
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
