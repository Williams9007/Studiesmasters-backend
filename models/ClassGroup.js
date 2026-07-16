import mongoose from "mongoose";

// A teaching group is intentionally separate from payment enrolments: it is
// the small, named classroom an admin assigns to one teacher.
const classGroupSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  curriculum: { type: String, required: true, trim: true },
  grade: { type: String, required: true, trim: true },
  subject: { type: String, required: true, trim: true },
  capacity: { type: Number, enum: [1, 5, 10], required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", default: null },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
  status: { type: String, enum: ["active", "full", "closed"], default: "active" },
}, { timestamps: true });

export default mongoose.models.ClassGroup || mongoose.model("ClassGroup", classGroupSchema);
