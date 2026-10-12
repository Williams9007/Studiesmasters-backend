// scripts/resync-moodle-classes.js
//
// CLI for POST /api/admin/sessions/resync-moodle: re-pushes every scheduled /
// live ClassSession to Moodle (delete+create calendar event path). Needed after
// fixing a Moodle WS problem (rotated token / missing service functions),
// because jobs that already hit dead_letter in the durable queue never retry on
// their own.
//
// Run AFTER scripts/moodle-sync-preflight.js is green:
//   node scripts/resync-moodle-classes.js --dry-run   # report only
//   node scripts/resync-moodle-classes.js             # re-push everything
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import ClassSession from "../models/ClassSession.js";
import { resyncAllClassSessionsToMoodle } from "../services/qao/scheduling.service.js";

const DRY_RUN = process.argv.includes("--dry-run");
const line = (s = "") => console.log(s);

if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not defined. Add it to your .env file.");
  process.exit(1);
}
await mongoose.connect(process.env.MONGO_URI);
try {
  const sessions = await ClassSession.find({ status: { $in: ["scheduled", "live"] } })
    .select("date startTime meetingStatus meetingLink moodleEventId")
    .sort({ date: 1, startTime: 1 })
    .lean();
  line(`Scheduled/live sessions: ${sessions.length}`);
  for (const s of sessions) {
    const d = s.date instanceof Date ? s.date.toISOString().slice(0, 10) : "?";
    line(`  ${d} ${s.startTime}  ${s.meetingStatus}  link=${s.meetingLink ? "yes" : "NO"}  moodleEvent=${s.moodleEventId || "none"}`);
  }

  if (DRY_RUN) {
    line("\n--dry-run: nothing was changed.");
  } else {
    const res = await resyncAllClassSessionsToMoodle({});
    line(`\nResync result: total=${res.total} synced=${res.synced} queued=${res.queued} failed=${res.failed}`);
    if (res.failed) line("Failures: check MoodleAuditLog rows (failure field) and run scripts/moodle-sync-preflight.js.");
  }
} finally {
  await mongoose.disconnect();
}
