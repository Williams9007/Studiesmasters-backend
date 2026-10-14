// One-off CLI: retro-fit SEPARATE_GROUPS mode onto already-provisioned courses
// so each StudiesMasters class group (a Moodle group inside the shared course)
// only sees its own members. New courses get this at creation (client.createCourses);
// this repairs courses created before that change.
//
// Read-then-write and idempotent: only courses whose groupmode is not already
// SEPARATE_GROUPS are updated, so rerunning changes nothing after the first pass.
//
// REQUIRES the Moodle web service function core_course_update_courses to be
// attached to the service the token uses. If it is missing, this exits with a
// clear message instead of silently doing nothing.
//
// Usage: node scripts/repair-class-isolation.mjs
import "dotenv/config";
import connectDB from "../config/db.js";
import { client } from "../services/moodle/client.js";
import { expectedCourses, COURSE_COUNT } from "../services/moodle/curriculum.js";

const SEPARATE_GROUPS = 1; // Moodle: 0 = no groups, 1 = separate groups

await connectDB();
try {
  const idnumbers = expectedCourses().map((c) => c.courseIdnumber);
  const courses = await client.getCourses(idnumbers);
  console.log(`Found ${courses.length} provisioned course(s) in Moodle (expected up to ${COURSE_COUNT}).`);

  const needFix = courses.filter((c) => Number(c.groupmode) !== SEPARATE_GROUPS);
  console.log(`${needFix.length} course(s) not yet in SEPARATE_GROUPS mode.`);

  if (!needFix.length) {
    console.log("Nothing to do — every course is already isolated. DONE.");
  } else {
    const payload = needFix.map((c) => ({ id: c.id, groupmode: SEPARATE_GROUPS, groupmodeforce: 1 }));
    const res = await client.updateCourses(payload);
    const updated = Array.isArray(res) ? res : [];
    console.log(`REPAIR RESULT: requested ${payload.length}, Moodle acknowledged ${updated.length}.`);
    console.log("Sample:", JSON.stringify(updated.slice(0, 3)));

    // Verify the write actually landed.
    const after = await client.getCourses(idnumbers);
    const stillOff = after.filter((c) => Number(c.groupmode) !== SEPARATE_GROUPS);
    console.log(`VERIFY: ${after.length - stillOff.length}/${after.length} course(s) now in SEPARATE_GROUPS mode.`);
    if (stillOff.length) {
      console.log("STILL OFF:", stillOff.map((c) => `${c.shortname}(id ${c.id})`).join(", "));
    }
  }
} catch (err) {
  // core_course_update_courses not attached -> Moodle access control exception.
  console.error("REPAIR FAILED:", err?.message || err);
  if (/access control exception|accessexception/i.test(String(err?.message || ""))) {
    console.error(
      "HINT: core_course_update_courses is likely NOT attached to the Moodle web service. " +
      "Ask the Moodle admin to add it to service id 3, then rerun this script."
    );
  }
  process.exitCode = 1;
} finally {
  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect();
}
