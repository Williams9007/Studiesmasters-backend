// src/models/Teacher.js
import mongoose from "mongoose";


const teacherSchema = new mongoose.Schema(
  {
    // Keep `name` for existing teacher records while using fullName everywhere
    // the current registration and dashboard flows expect it.
    name: { type: String, trim: true },
    fullName: { type: String, trim: true },
    // SM-TUT for tutors and SM-TM for tutor managers.
    userId: { type: String, required: true, unique: true, sparse: true, immutable: true, index: true },
    employeeRole: { type: String, enum: ["tutor", "tutor_manager"], default: "tutor" },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    password: { type: String, required: true },
    curriculum: { type: String, trim: true },
    experience: { type: String, trim: true },
    subjectsTeaching: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
    assignmentsGiven: [{ type: mongoose.Schema.Types.ObjectId, ref: "Assignment" }],
    resetToken: String,
    resetTokenExpiry: Date,
  },
  { timestamps: true }
);
export default mongoose.models.Teacher || mongoose.model("Teacher", teacherSchema);
