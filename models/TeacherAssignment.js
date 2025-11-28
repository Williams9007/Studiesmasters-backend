import mongoose from "mongoose";

const teacherAssignmentSchema = new mongoose.Schema({
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  curriculum: { type: String, required: true },
  package: { type: String, required: true },
  grade: { type: String, required: true },
  subject: { type: String, required: true },
  assignedAt: { type: Date, default: Date.now },
});

teacherAssignmentSchema.index(
  { teacherId: 1, curriculum: 1, package: 1, grade: 1, subject: 1 },
  { unique: true }
);

export default mongoose.model("TeacherAssignment", teacherAssignmentSchema);
