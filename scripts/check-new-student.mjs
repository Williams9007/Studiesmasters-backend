// Check the newest students' sync state: status, link, jobs.
import "dotenv/config";
import connectDB from "../config/db.js";
import Student from "../models/Student.js";
import MoodleLink from "../models/MoodleLink.js";
import mongoose from "mongoose";

await connectDB();
const SyncJob = mongoose.models.SyncJob || (await import("../models/SyncJob.js")).default;
const students = await Student.find({}).sort({ createdAt: -1 }).limit(3)
  .select("_id fullName userId grade curriculum subjectNames moodleSyncStatus createdAt").lean();
for (const s of students) {
  console.log("\nSTUDENT:", JSON.stringify({ _id: s._id, userId: s.userId, name: s.fullName, grade: s.grade, curriculum: s.curriculum, subjects: s.subjectNames, sync: s.moodleSyncStatus, created: s.createdAt }));
  const link = await MoodleLink.findOne({ studentRef: s._id }).lean();
  console.log("LINK:", link ? { moodleUserId: link.moodleUserId, enrolled: link.enrolledCourseIds } : "NONE");
  const jobs = await SyncJob.find({ "payload.studentId": s._id }).sort({ createdAt: -1 }).limit(2).lean();
  for (const j of jobs) console.log("JOB:", JSON.stringify({ status: j.status, attempts: j.attempts, lastError: j.lastError, type: j.type }));
}
const mongooseExit = (await import("mongoose")).default;
await mongooseExit.disconnect();
process.exit(0);
