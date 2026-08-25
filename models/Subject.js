// backend/models/subject.js
import mongoose from "mongoose";

const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  curriculum: { type: String },
  package: { type: String, required: true },
  grade: { type: String, required: true },
  price: { type: Number, required: true },
  // Optional Moodle course id (integer) so "Open class" sends a student straight
  // into the correct Moodle course via SSO. Left null until an admin assigns it.
  moodleCourseId: { type: Number, default: null },
});

// ✅ Prevent OverwriteModelError
export default mongoose.models.Subject || mongoose.model("Subject", subjectSchema);
