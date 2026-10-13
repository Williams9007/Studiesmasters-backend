import mongoose from "mongoose";

const teacherAssignmentSchema = new mongoose.Schema({
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true, index: true },
  curriculum: { type: String, required: true, trim: true },
  package: { type: String, required: true, trim: true },
  grade: { type: String, required: true, trim: true },
  subject: { type: String, required: true, trim: true },
  assignedAt: { type: Date, default: Date.now },
}, { timestamps: true });

teacherAssignmentSchema.index(
  { teacherId: 1, curriculum: 1, package: 1, grade: 1, subject: 1 },
  { unique: true }
);

export default mongoose.models.TeacherAssignment || mongoose.model("TeacherAssignment", teacherAssignmentSchema);
