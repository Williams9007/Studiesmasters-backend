import mongoose from "mongoose";

const teacherSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    password: { type: String, required: true, minlength: 6 },

    // 📘 New fields
    curriculum: { type: String, enum: ["GES", "CAMBRIDGE"], required: true }, // Curriculum the teacher teaches
    subjectsTeaching: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Subject" },
    ], // References to subjects
    assignmentsGiven: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Assignment" },
    ], // Assignments the teacher created

    lessonNotes: [
      {
        title: String,
        content: String,
        createdAt: { type: Date, default: Date.now },
      },
    ], // Embedded lesson notes

    experience: { type: String, required: true },

    // 🔐 Added for password reset functionality
    resetToken: { type: String },
    resetTokenExpiry: { type: Date },
  },
  { timestamps: true }
);

const Teacher = mongoose.model("Teacher", teacherSchema);
export default Teacher;
