// backend/models/Resource.js
import mongoose from "mongoose";

const resourceSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "QaoUser", required: true },
    title: { type: String, required: true }, // e.g., "Math Lesson Note"
    type: { type: String, enum: ["lesson", "timetable"], required: true },
    fileUrl: { type: String, required: true }, // path to uploaded file
    approved: { type: Boolean, default: false },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model("Resource", resourceSchema);
