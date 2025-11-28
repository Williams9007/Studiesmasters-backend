import mongoose from "mongoose";

const timetableSchema = new mongoose.Schema({
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  subjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Subject", required: true },
  classLevel: String,
  fileUrl: String, // PDF, Excel, or uploaded timetable
  status: { type: String, enum: ["Pending", "Approved", "Flagged"], default: "Pending" },
  feedback: String,
  uploadedAt: { type: Date, default: Date.now },
});

export default mongoose.model("Timetable", timetableSchema);
