// models/ClassEnrollment.js
import mongoose from "mongoose";

const classEnrollmentSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
  curriculum: { type: String, required: true, trim: true },
  package: { type: String, required: true, trim: true },
  grade: { type: String, required: true, trim: true },
  subject: { type: String, required: true, trim: true },
  enrolledAt: { type: Date, default: Date.now },
}, { timestamps: true });

classEnrollmentSchema.index(
  { curriculum: 1, package: 1, grade: 1, subject: 1, studentId: 1 },
  { unique: true }
);

export default mongoose.models.ClassEnrollment || mongoose.model("ClassEnrollment", classEnrollmentSchema);
