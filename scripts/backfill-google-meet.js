// scripts/backfill-google-meet.js
//
// Backfills the Google Meet co-host tracking fields on ClassSessions that were
// created BEFORE the co-host feature shipped. Without this, older sessions have
// a meetingLink but no googleMeet.ownerEmail / googleMeet.teacherEmail and no
// coHostStatus, so the admin dashboard and the teacher join endpoint would show
// them as unconfigured.
//
// What it does, per session:
//   * googleMeet.ownerEmail   <- virtualclass@studiesmasters.com (or GOOGLE_MEET_OWNER_EMAIL)
//   * googleMeet.meetingLink  <- existing top-level meetingLink
//   * googleMeet.meetingCode / conferenceId / calendarEventId <- copied when present
//   * googleMeet.teacherEmail <- the assigned teacher's googleMeetEmail (only when verified)
//   * coHostStatus            <- invited | teacher_verified | not_configured
//
// Usage (from Studiesmasters-backend):
//   node scripts/backfill-google-meet.js            (apply)
//   node scripts/backfill-google-meet.js --dry-run  (report only)
import dotenv from "dotenv";
import mongoose from "mongoose";
import Teacher from "../models/teacher.js";
import ClassSession from "../models/ClassSession.js";

dotenv.config();

const MONGO_URI =
  process.env.MONGO_URI ||
  (process.env.MONGO_USER && process.env.MONGO_HOST
    ? "mongodb+srv://" + encodeURIComponent(process.env.MONGO_USER) + ":" + encodeURIComponent(process.env.MONGO_PASSWORD || "") + "@" + process.env.MONGO_HOST + "/" + encodeURIComponent(process.env.MONGO_DB_NAME || "test")
    : null);

if (!MONGO_URI) {
  console.error("MONGO_URI (or MONGO_USER/MONGO_HOST/...) is not defined. Add it to your .env file.");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const OWNER_EMAIL = process.env.GOOGLE_MEET_OWNER_EMAIL || "virtualclass@studiesmasters.com";

await mongoose.connect(MONGO_URI);
try {
  // Only sessions that actually have a Meet link are interesting.
  const sessions = await ClassSession.find({
    meetingLink: { $nin: ["", null] },
  })
    .populate("teacher", "fullName email googleMeetEmail googleAccountVerified")
    .limit(5000);

  let updated = 0;
  let skipped = 0;
  const counts = { invited: 0, teacher_verified: 0, not_configured: 0 };

  for (const session of sessions) {
    const already =
      session.googleMeet?.ownerEmail === OWNER_EMAIL &&
      session.googleMeet?.meetingLink &&
      session.coHostStatus;
    if (already) { skipped++; continue; }

    const teacher = session.teacher;
    const teacherGoogleEmail = teacher?.googleAccountVerified ? teacher.googleMeetEmail : null;
    const coHostStatus = teacher?.googleAccountVerified && teacherGoogleEmail
      ? "invited"
      : teacher?.googleAccountVerified
        ? "teacher_verified"
        : "not_configured";
    counts[coHostStatus]++;

    session.googleMeet = {
      ownerEmail: OWNER_EMAIL,
      teacherEmail: teacherGoogleEmail || "",
      meetingLink: session.meetingLink || "",
      meetingCode: session.meetingCode || "",
      conferenceId: session.conferenceId || "",
      calendarEventId: session.calendarEventId || "",
    };
    session.coHostStatus = coHostStatus;
    session.meetingOwner = session.meetingOwner || OWNER_EMAIL;

    if (!dryRun) await session.save();
    updated++;
  }

  console.log(`${dryRun ? "[dry-run] " : ""}Backfill complete:`);
  console.log(`  sessions scanned : ${sessions.length}`);
  console.log(`  updated          : ${updated}`);
  console.log(`  already current  : ${skipped}`);
  console.log(`  coHostStatus     : invited=${counts.invited} teacher_verified=${counts.teacher_verified} not_configured=${counts.not_configured}`);
} catch (err) {
  console.error("Backfill failed:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
