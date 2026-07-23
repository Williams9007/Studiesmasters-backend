import mongoose from "mongoose";

const quizSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  subject: { type: String, required: true },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  classGroup: { type: mongoose.Schema.Types.ObjectId, ref: "ClassGroup", required: true },
  questions: [
    {
      questionText: { type: String, required: true },
      options: [{ type: String, required: true }],
      correctAnswer: { type: String, required: true },
      points: { type: Number, default: 1 }
    }
  ],
  dueDate: { type: Date, required: true },
  timeLimit: { type: Number, default: 30 }, // minutes
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
}, { timestamps: true });

export default mongoose.models.Quiz || mongoose.model("Quiz", quizSchema);