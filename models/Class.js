import mongoose from "mongoose";

const classSchema = new mongoose.Schema({
  curriculum: { type: String, required: true, trim: true }, // GES, Cambridge, etc.
  package: { type: String, required: true, trim: true }, // EC, WC, HS, etc.
  grade: { type: String, required: true, trim: true }, // e.g. "4", "JHS 1", "Stage 7-11"
  subject: { type: String, required: true, trim: true },
  className: { type: String, required: true, unique: true, trim: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", index: true },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
  maxStudents: { type: Number, default: 30 },
  duration: { type: String, trim: true },
  price: { type: Number },
  status: { type: String, enum: ["active", "full", "closed"], default: "active" },
}, { timestamps: true });

export default mongoose.models.Class || mongoose.model("Class", classSchema);
