// scripts/diagnose-class-moodle-resolution.js
//
// READ-ONLY: for every scheduled/live class, run the REAL course-resolution logic
// (services/moodle/courseMapper.js#getCourseIdsFor — the same function
// syncClass.js uses) and report whether the class resolves to a Moodle course.
//
// A class that resolves to NO course id is pushed as a SITE event, and a site
// event is NOT visible inside the course pages/calendar the students and teacher
// actually use — which is exactly what "scheduled classes are not synced to
// Moodle" looks like in practice.
//
// Run: node scripts/diagnose-class-moodle-resolution.js
import dotenv from "dotenv";
dotenv.config();

import connectDB from "../config/db.js";
import mongoose from "mongoose";
import ClassSession from "../models/ClassSession.js";
import ClassGroup from "../models/ClassGroup.js";
import Teacher from "../models/teacher.js";
import { getCourseIdsFor } from "../services/moodle/courseMapper.js";
import { toMoodleDisplay } from "../services/moodle/syncClass.js";

const line = (s = "") => console.log(s);

async function main() {
  await connectDB();
  const sessions = await ClassSession.find({ status: { $in: ["scheduled", "live"] } })
    .populate("classGroup", "code subject grade curriculum")
    .populate("teacher", "fullName")
    .populate("substituteTeacher", "fullName")
    .sort({ date: 1 })
    .lean();

  line(`\n=== Scheduled/live classes: Moodle course resolution (${sessions.length}) ===`);
  let resolved = 0;
  let unresolved = 0;

  for (const s of sessions) {
    const g = s.classGroup || {};
    const courseIds = await getCourseIdsFor({
      subjects: g.subject ? [{ name: g.subject }] : [],
      curriculum: g.curriculum || null,
      packageName: null,
      grade: g.grade || null,
    });
    const ok = courseIds.length > 0;
    if (ok) resolved += 1; else unresolved += 1;
    const d = toMoodleDisplay(s);
    line(`\n  ${String(s.date).slice(0, 10)} ${s.startTime}-${s.endTime}  [${s.status}]`);
    line(`    group .......... ${g.code || "?"} · subject "${g.subject || ""}" · curriculum "${g.curriculum || ""}" · grade "${g.grade || ""}"`);
    line(`    teacher ........ ${d.teacher || "(blank)"}`);
    line(`    meetingLink .... ${d.meetingLink || "(EMPTY — Moodle event says 'link pending')"}`);
    line(`    moodleEventId .. ${s.moodleEventId || "(none recorded)"}`);
    line(`    -> courseIds ... ${ok ? courseIds.join(", ") : "NONE  <-- pushed as a SITE event (not inside the course)"}`);
  }

  line(`\n=== Summary: ${resolved} resolved, ${unresolved} unresolved ===`);
  if (unresolved) {
    line("\nFixes for the unresolved ones:");
    line("  - The class subject/grade must match a CourseMapping 'Subject' + 'Grade' exactly");
    line("    (e.g. group subject \"Maths\" vs mapping \"Mathematics\"; grade \"Grade 4\" vs \"Primary 4\").");
    line("  - Normalise the group's subject/grade on the Timetable screen, or add a mapping");
    line("    for the exact spelling (Admin → Moodle → course mappings, subjectName fallback).");
  }
  line();
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("\nDiagnostic failed:", err.message);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
