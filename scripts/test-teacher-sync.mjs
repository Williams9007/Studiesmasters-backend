// Test teacher sync end-to-end for each teacher.
import "dotenv/config";
import connectDB from "../config/db.js";
import Teacher from "../models/teacher.js";
import { syncProfile } from "../services/moodle/syncProfile.js";
import MoodleLink from "../models/MoodleLink.js";
import mongoose from "mongoose";

await connectDB();
const teachers = await Teacher.find({}).select("_id fullName").lean();
for (const t of teachers) {
  const r = await syncProfile({ id: t._id.toString(), role: "teacher" });
  const link = await MoodleLink.findOne({ teacherRef: t._id }).lean();
  console.log(`${t.fullName}: ok=${r.ok} desired=${JSON.stringify(r.desired)} removed=${JSON.stringify(r.removed || [])} linkEnrolled=${JSON.stringify(link?.enrolledCourseIds || [])}`);
}
await mongoose.disconnect();
process.exit(0);
