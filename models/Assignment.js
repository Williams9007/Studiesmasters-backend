import mongoose from "mongoose";

const assignmentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  subject: { 
    type: [String], // multiple subjects allowed
    required: true
  },
  description: { type: String },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  classGroup: { type: mongoose.Schema.Types.ObjectId, ref: "ClassGroup", default: null },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
  submissions: [
    {
      studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student" },
      submissionText: { type: String },
      fileUrl: { type: String }, // optional file attachment
      submittedAt: { type: Date, default: Date.now },
      status: { type: String, enum: ["pending", "submitted", "reviewed", "overdue"], default: "pending" },
      score: { type: Number, min: 0, max: 100 },
      feedback: { type: String, trim: true },
      reviewedAt: { type: Date },
    }
  ],
  dueDate: { type: Date, required: true },
}, {
  timestamps: true // adds createdAt and updatedAt
});

export default mongoose.model("Assignment", assignmentSchema);
