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

    // ---- Tutor Manager (QAO) module additions (all backward compatible) ----
    photo: { type: String, trim: true, default: null },
    qualifications: { type: String, trim: true, default: "" },
    employmentStatus: {
      type: String,
      enum: ["active", "on_leave", "suspended", "former"],
      default: "active",
    },
    // QAO-only private notes. Never exposed to teachers/students.
    internalNotes: { type: String, default: "" },
    // Phase 3: embedded weekly availability (a separate collection is not
    // warranted unless per-subject/dated availability is required later).
    availability: [
      {
        day: { type: String, trim: true },
        start: { type: String, trim: true },
        end: { type: String, trim: true },
      },
    ],

    resetToken: String,
    resetTokenExpiry: Date,
  },
  { timestamps: true }
);
export default mongoose.models.Teacher || mongoose.model("Teacher", teacherSchema);
