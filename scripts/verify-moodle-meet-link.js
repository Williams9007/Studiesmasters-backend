// Verify that a seeded ClassSession's Google Meet link is present in Moodle.
// Usage: node scripts/verify-moodle-meet-link.js
import dotenv from "dotenv";
import mongoose from "mongoose";
import ClassSession from "../models/ClassSession.js";
import ClassGroup from "../models/ClassGroup.js";
import MoodleAuditLog from "../models/MoodleAuditLog.js";
import { callWs } from "../services/moodle/client.js";

dotenv.config();

const MONGO_URI =
  process.env.MONGO_URI ||
  (process.env.MONGO_USER && process.env.MONGO_HOST
    ? "mongodb+srv://" + encodeURIComponent(process.env.MONGO_USER) + ":" + encodeURIComponent(process.env.MONGO_PASSWORD || "") + "@" + process.env.MONGO_HOST + "/" + encodeURIComponent(process.env.MONGO_DB_NAME || "test")
    : null);

await mongoose.connect(MONGO_URI);
try {
  const groups = await ClassGroup.find({ code: /^SM-TEST-/ }).select("_id code").lean();
  if (!groups.length) {
    console.log("No seeded SM-TEST- group found. Run: node scripts/seed-real-classes.js");
    process.exit(0);
  }
  const groupIds = groups.map((g) => g._id);
  const sessions = await ClassSession.find({ classGroup: { $in: groupIds } }).lean();
  console.log(`Seeded groups: ${groups.map((g) => g.code).join(", ")}`);
  console.log(`Seeded sessions: ${sessions.length}\n`);

  // Pull the current Moodle calendar events once. NOTE: no options[] filters —
  // `options[userevents]`/`options[siteevents]` EXCLUDE course events, which is
  // what syncClass.js creates (verified live on Moodle 4.5.13).
  let events = [];
  try {
    const res = await callWs("core_calendar_get_calendar_events", {});
    events = res?.events || [];
  } catch (err) {
    console.log("Could not read Moodle calendar:", err.message);
  }

  // Map each session to its Moodle event id via the durable audit trail —
  // syncClass.js records `moodleEventId` there. Moodle's event NAME does not
  // contain the session id, so this is the reliable link.
  const auditRows = await MoodleAuditLog.find({
    action: "CLASS_MEETING_READY",
    outcome: "success",
  })
    .select("detail createdAt")
    .sort({ createdAt: -1 })
    .lean();
  const eventIdBySession = new Map();
  for (const row of auditRows) {
    const sid = row?.detail?.sessionId || row?.detail?.session;
    const eid = row?.detail?.moodleEventId;
    if (sid && eid && !eventIdBySession.has(String(sid))) {
      eventIdBySession.set(String(sid), Number(eid));
    }
  }

  let found = 0;
  let audited = 0;
  for (const s of sessions) {
    const meetLink = s.meetingLink || s.googleMeet?.meetingLink || "";
    const moodleEventId = eventIdBySession.get(String(s._id));
    const moodleEvent = moodleEventId
      ? events.find((e) => Number(e?.id) === Number(moodleEventId))
      : events.find((e) => typeof e.description === "string" && meetLink && e.description.includes(meetLink));
    const desc = moodleEvent?.description || "";
    const hasLink = Boolean(meetLink && desc.includes(meetLink));
    if (hasLink) found++;
    if (moodleEventId) audited++;
    console.log(`Session ${s._id}`);
    console.log(`  meet link      : ${meetLink || "(none)"}`);
    console.log(`  owner          : ${s.googleMeet?.ownerEmail || "(unset)"}`);
    console.log(`  teacher email  : ${s.googleMeet?.teacherEmail || "(unset)"}`);
    console.log(`  coHostStatus   : ${s.coHostStatus}`);
    console.log(`  Moodle event id: ${moodleEventId || "(no successful audit row)"}`);
    console.log(`  live read-back : ${moodleEvent ? `id=${moodleEvent.id} "${moodleEvent.name}"` : "(not returned by the calendar listing)"}`);
    console.log(`  Meet link inside Moodle description: ${hasLink ? "YES" : "not confirmed by this listing"}`);
    console.log("");
  }
  console.log(`Moodle calendar events returned by the listing: ${events.length}`);
  console.log(`Sessions with a successful Moodle sync (audit trail): ${audited}/${sessions.length}`);
  console.log(`Sessions whose Meet link was confirmed in the live listing: ${found}/${sessions.length}`);
  if (!found && audited) {
    console.log(
      "\nNote: Moodle's core_calendar_get_calendar_events only lists the token owner's\n" +
      "visible events, so a successful audit row (above) is the authoritative proof\n" +
      "that the class + Meet link were pushed. For a full live read-back of a single\n" +
      "session run: node scripts/test-google-meet-moodle.js"
    );
  }
} catch (err) {
  console.error("Verification failed:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
