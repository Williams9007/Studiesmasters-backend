// Verify teacher MoodleLinks + live Moodle enrollment role.
import "dotenv/config";
import connectDB from "../config/db.js";
import MoodleLink from "../models/MoodleLink.js";
import { callWs } from "../services/moodle/client.js";
import mongoose from "mongoose";

await connectDB();
const links = await MoodleLink.find({ role: "teacher" }).lean();
console.log("TEACHER LINKS:", links.length);
for (const l of links) {
  let roleInfo = "n/a";
  if (l.moodleUserId) {
    try {
      const ev = await callWs("core_enrol_get_enrolled_users", { courseid: (l.enrolledCourseIds || [])[0] || 0 });
      const u = (ev || []).find((x) => String(x.id) === String(l.moodleUserId));
      const roles = (u?.roles || []).map((r) => r.roleid).join(",");
      roleInfo = u ? `roles=[${roles}] in course ${(l.enrolledCourseIds || [])[0]}` : "not enrolled in first course";
    } catch (e) { roleInfo = "lookup-err: " + e.message.slice(0, 60); }
  }
  console.log(`- ${l.moodleUsername} | moodleUserId=${l.moodleUserId} | courses=${(l.enrolledCourseIds || []).length} | ${roleInfo}`);
}
await mongoose.disconnect();
process.exit(0);
