import mongoose from "mongoose";

const lessonSchema = new mongoose.Schema({
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  subjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Subject", required: true },
  title: String,
  description: String,
  noteFileUrl: String, // PDF or doc of lesson note
  videoUrl: String, // Optional: link to class video
  uploadedAt: { type: Date, default: Date.now },
  reviewedByQAO: { type: Boolean, default: false },
  qaoFeedback: String,
});

export default mongoose.model("Lesson", lessonSchema);
