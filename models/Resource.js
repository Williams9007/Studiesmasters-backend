import mongoose from "mongoose";

const resourceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  fileUrl: { type: String, required: true },
  fileType: { type: String, default: "pdf" },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  subject: { type: String },
  curriculum: { type: String },
  classGroup: { type: mongoose.Schema.Types.ObjectId, ref: "ClassGroup" },
  approved: { type: Boolean, default: false },
  comment: { type: String },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  reviewedAt: { type: Date },
}, { timestamps: true });

export default mongoose.model("Resource", resourceSchema);