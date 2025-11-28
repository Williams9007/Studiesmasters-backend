import mongoose from "mongoose";

const assignmentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subject: { 
    type: [String], // multiple subjects allowed
    required: true
  },
  description: { type: String },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // teacher who created it
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], // students assigned
  submissions: [
    {
      studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      submissionText: { type: String },
      fileUrl: { type: String }, // optional file attachment
      submittedAt: { type: Date, default: Date.now },
      status: { type: String, enum: ["pending", "submitted", "overdue"], default: "pending" }
    }
  ],
  dueDate: { type: Date, required: true },
}, {
  timestamps: true // adds createdAt and updatedAt
});

export default mongoose.model("Assignment", assignmentSchema);
