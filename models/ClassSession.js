import mongoose from "mongoose";

// ClassSession is the operational source of truth for teaching activities.
// It REFERENCEs ClassGroup and Teacher (no duplicated class data) so that
// historical teacher assignments are preserved even if a group is reassigned.
const classSessionSchema = new mongoose.Schema(
  {
    classGroup: { type: mongoose.Schema.Types.ObjectId, ref: "ClassGroup", required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true, index: true },
    date: { type: Date, required: true, index: true },
    startTime: { type: String, required: true, trim: true }, // "14:00"
    endTime: { type: String, required: true, trim: true }, // "15:00"
    durationMinutes: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["scheduled", "live", "completed", "cancelled"],
      default: "scheduled",
      index: true,
    },
    meetingLink: { type: String, trim: true, default: "" },
// ---- Virtual classroom (Google Meet) additions (all backward compatible) ----
    // Provider is fixed to "google-meet" but kept a field so the system could
    // swap providers later without a schema change.
    meetingProvider: { type: String, trim: true, default: "google-meet" },
    // Short human-friendly code, e.g. "abc-defg-hij".
    meetingCode: { type: String, trim: true, default: "" },
    // Identifier Google returns for the conference.
    conferenceId: { type: String, trim: true, default: "" },
    // Identifier of the Google Calendar event backing the meeting.
    calendarEventId: { type: String, trim: true, default: "" },
    recordingLink: { type: String, trim: true, default: "" },
    // Lifecycle of the meeting itself (independent of the class `status`):
    //   ready  -> a real/mock meet link is available
    //   pending -> generation not attempted yet or failed (regenerate later)
    //   failed -> last generation attempt errored
    meetingStatus: {
      type: String,
      enum: ["ready", "pending", "failed"],
      default: "pending",
      index: true,
    },
    // Per-student join/leave/duration. Used to compute attendance reports.
    // The client (or the teacher/QAO correction flow) writes these records.
    attendance: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
        joinedAt: { type: Date, default: null },
        leftAt: { type: Date, default: null },
        duration: { type: Number, default: 0 }, // minutes
        source: {
          type: String,
          enum: ["client", "teacher", "qao", "auto"],
          default: "client",
        },
      },
    ],
    // Substitute covering this session. The original `teacher` is kept intact
    // for history/reporting.
    substituteTeacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", default: null },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

classSessionSchema.index({ teacher: 1, date: 1 });
classSessionSchema.index({ classGroup: 1, date: 1 });

classSessionSchema.pre("validate", function computeDuration(next) {
  if (this.startTime && this.endTime) {
    const [sh, sm] = String(this.startTime).split(":").map(Number);
    const [eh, em] = String(this.endTime).split(":").map(Number);
    if ([sh, sm, eh, em].every(Number.isFinite)) {
      this.durationMinutes = Math.max(0, eh * 60 + em - (sh * 60 + sm));
    }
  }
  next();
});

export default mongoose.models.ClassSession || mongoose.model("ClassSession", classSessionSchema);
