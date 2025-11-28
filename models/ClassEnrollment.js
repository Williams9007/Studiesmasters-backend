// models/ClassEnrollment.js
import mongoose from "mongoose";

const classEnrollmentSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  curriculum: { type: String, required: true },
  package: { type: String, required: true },
  grade: { type: String, required: true },
  subject: { type: String, required: true },
  enrolledAt: { type: Date, default: Date.now },
});

classEnrollmentSchema.index(
  { curriculum: 1, package: 1, grade: 1, subject: 1, studentId: 1 },
  { unique: true }
);

export default mongoose.model("ClassEnrollment", classEnrollmentSchema);
