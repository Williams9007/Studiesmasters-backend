// backend/models/subject.js
import mongoose from "mongoose";

const subjectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  curriculum: { type: String },
  package: { type: String, required: true },
  grade: { type: String, required: true },
  price: { type: Number, required: true },
});

// ✅ Prevent OverwriteModelError
export default mongoose.models.Subject || mongoose.model("Subject", subjectSchema);
