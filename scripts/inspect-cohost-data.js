// Inspect the live StudiesMasters data relevant to the Google Meet co-host flow.
import dotenv from "dotenv";
import mongoose from "mongoose";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";

dotenv.config();

const MONGO_URI =
  process.env.MONGO_URI ||
  (process.env.MONGO_USER && process.env.MONGO_HOST
    ? "mongodb+srv://" + encodeURIComponent(process.env.MONGO_USER) + ":" + encodeURIComponent(process.env.MONGO_PASSWORD || "") + "@" + process.env.MONGO_HOST + "/" + encodeURIComponent(process.env.MONGO_DB_NAME || "test")
    : null);

await mongoose.connect(MONGO_URI);
try {
  const [teachers, students, groups, sessions] = await Promise.all([
    Teacher.countDocuments(),
    Student.countDocuments(),
    ClassGroup.countDocuments(),
    ClassSession.countDocuments(),
  ]);
  console.log(`Teachers: ${teachers}  Students: ${students}  ClassGroups: ${groups}  ClassSessions: ${sessions}\n`);

  console.log("--- Teacher Google Meet readiness ---");
  const t = await Teacher.find()
    .select("fullName name email googleMeetEmail googleAccountVerified googleOAuthState employmentStatus")
    .limit(15)
    .lean();
  for (const x of t) {
    console.log(
      `  ${(x.fullName || x.name || "-").padEnd(24)} | ${String(x.email || "-").padEnd(32)} | google=${x.googleMeetEmail || "(none)"} | verified=${Boolean(x.googleAccountVerified)} | state=${x.googleOAuthState || "-"}`
    );
  }
  if (!t.length) console.log("  (no teachers)");

  console.log("\n--- Recent ClassSessions (Meet ownership + co-host) ---");
  const s = await ClassSession.find()
    .select("status date startTime endTime meetingLink meetingStatus meetingOwner coHostStatus googleMeet")
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();
  for (const x of s) {
    const link = x.meetingLink || x.googleMeet?.meetingLink || "(no link)";
    console.log(
      `  ${String(x.date ? new Date(x.date).toISOString().slice(0, 10) : "-")} ${String(x.startTime || "").padEnd(5)} ${String(x.status).padEnd(10)} | owner=${x.googleMeet?.ownerEmail || x.meetingOwner || "(unset)"} | teacher=${x.googleMeet?.teacherEmail || "(unset)"} | coHost=${x.coHostStatus || "(unset)"} | ${link}`
    );
  }
  if (!s.length) console.log("  (no class sessions)");
} catch (err) {
  console.error("Inspection failed:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
