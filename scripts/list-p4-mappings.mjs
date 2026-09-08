// List CourseMappings for GES Primary 4 (to identify courses to delete).
import "dotenv/config";
import connectDB from "../config/db.js";
import CourseMapping from "../models/CourseMapping.js";

await connectDB();
const mappings = await CourseMapping.find({ curriculum: "GES", grade: "Primary 4" }).lean();
for (const m of mappings) {
  console.log(JSON.stringify({ id: m._id, subject: m.subjectName, targets: m.targets }));
}
const mongoose = (await import("mongoose")).default;
await mongoose.disconnect();
process.exit(0);
