import mongoose from "mongoose";

const classSchema = new mongoose.Schema({
  curriculum: { type: String, required: true }, // GES, Cambridge, etc.
  package: { type: String, required: true }, // EC, WC, HS, etc.
  grade: { type: String, required: true }, // e.g. "4", "JHS 1", "Stage 7-11"
  subject: { type: String, required: true },
  className: { type: String, required: true, unique: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher" },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  maxStudents: { type: Number, default: 30 },
  duration: { type: String },
  price: { type: Number },
  status: { type: String, enum: ["active", "full", "closed"], default: "active" },
}, { timestamps: true });

export default mongoose.model("Class", classSchema);
