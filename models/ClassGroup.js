import mongoose from "mongoose";

// A teaching group is intentionally separate from payment enrolments: it is
// the small, named classroom an admin assigns to one teacher.
const classGroupSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  curriculum: { type: String, required: true, trim: true },
  grade: { type: String, required: true, trim: true },
  subject: { type: String, required: true, trim: true },
  // Capacity is deliberately restricted to 1 / 5 / 10: these mirror the
  // pricing packages and the auto-grouping algorithm (classGroupService).
  capacity: { type: Number, enum: [1, 5, 10], required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", default: null },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
  status: { type: String, enum: ["active", "full", "closed"], default: "active" },

  // ---- Tutor Manager (QAO) module additions (all backward compatible) ----
  schedule: {
    day: { type: String, trim: true, default: "" },
    startTime: { type: String, trim: true, default: "" },
    endTime: { type: String, trim: true, default: "" },
  },
// Recurring weekly timetable: a class can meet MULTIPLE times per week
  // (e.g. Mon 09:00 + Wed 11:00). Each slot is a recurring day/time block that
  // the scheduler expands into concrete ClassSessions over a chosen term range.
  // Kept separate from the singular legacy `schedule` for backward compatibility.
  weeklySlots: [
    {
      day: { type: String, trim: true, default: "" },     // "Monday"..."Sunday"
      startTime: { type: String, trim: true, default: "" }, // "09:00"
      endTime: { type: String, trim: true, default: "" },   // "10:00"
    },
  ],
  meetingLink: { type: String, trim: true, default: "" },
}, { timestamps: true });

export default mongoose.models.ClassGroup || mongoose.model("ClassGroup", classGroupSchema);
