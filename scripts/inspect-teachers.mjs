// Inspect teachers that resolved to zero courses.
import "dotenv/config";
import connectDB from "../config/db.js";
import Teacher from "../models/teacher.js";
import mongoose from "mongoose";

await connectDB();
const teachers = await Teacher.find({}).lean();
for (const t of teachers) {
  console.log(`--- ${t.fullName} (${t.userId || "no userId"})`);
  console.log("  curriculum:", JSON.stringify(t.curriculum));
  console.log("  subjectsTeaching:", JSON.stringify((t.subjectsTeaching || []).map(s => String(s))));
  console.log("  subjectsTeachingNames:", JSON.stringify(t.subjectsTeachingNames || t.subjectNames || null));
  console.log("  email:", t.email);
}
await mongoose.disconnect();
process.exit(0);
