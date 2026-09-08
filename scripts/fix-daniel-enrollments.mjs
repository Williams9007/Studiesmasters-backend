// Remove stale Primary 4 enrollments (courses 4, 6) from Daniel SHS3 (moodleUserId 5).
import "dotenv/config";
import connectDB from "../config/db.js";
import MoodleLink from "../models/MoodleLink.js";
import { client } from "../services/moodle/client.js";

await connectDB();
const STALE = [4, 6]; // GES Primary 4 Mathematics, GES Primary 4 English
try {
  for (const courseid of STALE) {
    await client.unenroll([{ userid: 5, courseid, roleid: 5 }]);
    console.log(`unenrolled userid 5 from courseid ${courseid}`);
  }
} catch (e) {
  console.log("UNENROLL ERROR:", e.message);
}
const link = await MoodleLink.findOne({ moodleUserId: 5 });
if (link) {
  link.enrolledCourseIds = (link.enrolledCourseIds || []).filter((c) => !STALE.includes(c));
  link.lastEnrollSyncAt = new Date();
  await link.save();
  console.log("LINK UPDATED:", { username: link.moodleUsername, enrolledCourseIds: link.enrolledCourseIds });
}
const mongoose = (await import("mongoose")).default;
await mongoose.disconnect();
process.exit(0);
