import mongoose from "mongoose";

const studentSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, required: true },
    password: { type: String, required: true, minlength: 6 },
    curriculum: { type: String, enum: ["GES", "CAMBRIDGE"], required: true },
    package: { type: String, required: true },
    grade: { type: String, required: true },
    subjectsEnrolled: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Subject" },
    ],
    assignmentsSubmitted: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Assignment" },
    ],

    // 🔐 Added for password reset functionality
    resetToken: { type: String },
    resetTokenExpiry: { type: Date },
  },
  { timestamps: true }
);

const Student = mongoose.model("Student", studentSchema);
export default Student;
