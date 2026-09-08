// Final verification: MoodleLinks state + per-user Moodle lookup.
import "dotenv/config";
import connectDB from "../config/db.js";
import MoodleLink from "../models/MoodleLink.js";
import { callWs } from "../services/moodle/client.js";

await connectDB();
const links = await MoodleLink.find({ role: "student" }).lean();
console.log("LINKS:", links.length);
for (const l of links) {
  let moodle = "n/a";
  if (l.moodleUserId && !configDry()) {
    try {
      const det = await callWs("core_user_get_users_by_field", { field: "id", "values[0]": String(l.moodleUserId) });
      moodle = det?.[0] ? `id=${det[0].id} name=${det[0].fullname}` : "NOT FOUND IN MOODLE";
    } catch (e) { moodle = "lookup-err"; }
  }
  console.log(`- ${l.moodleUsername} | moodleUserId=${l.moodleUserId} | enrolled=${JSON.stringify(l.enrolledCourseIds || [])} | moodle: ${moodle}`);
}
function configDry() { return false; }
const mongoose = (await import("mongoose")).default;
await mongoose.disconnect();
process.exit(0);
