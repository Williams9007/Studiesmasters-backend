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
    // Legacy field - kept for backward compatibility during migration.
    // New code should use the `recording` object below.
    recordingLink: { type: String, trim: true, default: "" },
    // ---- Recording Lifecycle (Google Drive) ----
    // Stores recording metadata when Google Meet recording is processed.
    recording: {
      status: {
        type: String,
        enum: ["pending", "processing", "available", "failed", "archived"],
        default: "pending",
        index: true,
      },
      driveFileId: { type: String, trim: true, default: "" },
      driveFolderId: { type: String, trim: true, default: "" },
      streamUrl: { type: String, trim: true, default: "" },
      thumbnail: { type: String, trim: true, default: "" },
      duration: { type: Number, default: 0 },
      fileSize: { type: Number, default: 0 },
      uploadedAt: { type: Date, default: null },
      available: { type: Boolean, default: false },
      downloadAllowed: { type: Boolean, default: false },
      moodleResourceId: { type: String, trim: true, default: "" },
      processedAt: { type: Date, default: null },
    },
    // ---- AI Feature Preparation (Future Use) ----
    aiData: {
      transcript: { type: String, trim: true, default: "" },
      summary: { type: String, trim: true, default: "" },
      keywords: [{ type: String, trim: true }],
      chapters: [{
        title: { type: String, trim: true },
        timestamp: { type: Number },
        duration: { type: Number },
      }],
      generatedQuestions: [{
        question: { type: String, trim: true },
        type: { type: String, enum: ["multiple-choice", "short-answer", "essay"], default: "multiple-choice" },
        options: [{ type: String, trim: true }],
        correctAnswer: { type: String, trim: true },
      }],
      flashcards: [{
        front: { type: String, trim: true },
        back: { type: String, trim: true },
        topic: { type: String, trim: true },
      }],
    },
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
    // ---- Google Meet Co-host Tracking (Phase 6E - Enhanced) ----
    // Tracks the co-host assignment state for the teacher's Google account.
    // Note: Co-host permissions are controlled by Google Workspace settings,
    // not by this field. This is for tracking and UI purposes only.
    coHostStatus: {
      type: String,
      enum: [
        "not_configured",      // Teacher has not connected Google account
        "teacher_verified",    // Teacher Google identity verified via OAuth
        "invited",             // Teacher Google email added to meeting attendee list
        "active",              // Teacher successfully has meeting control (co-host)
        "manual_required"      // Google Workspace requires manual co-host assignment
      ],
      default: "not_configured",
      index: true,
    },
    // Google Meet metadata (expanded from existing flat fields for clarity)
    googleMeet: {
      // The meeting owner (always the company account)
      ownerEmail: {
        type: String,
        trim: true,
        default: "virtualclass@studiesmasters.com",
      },
      // The teacher's verified Google email (for co-host access)
      teacherEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: null,
      },
      // Existing meeting fields (kept for backward compatibility)
      meetingLink: { type: String, trim: true, default: "" },
      meetingCode: { type: String, trim: true, default: "" },
      conferenceId: { type: String, trim: true, default: "" },
      calendarEventId: { type: String, trim: true, default: "" },
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
    // ---- Moodle display sync tracking (set after successful push) ----
    moodleEventId: { type: Number, default: null },
    moodleCourseId: { type: Number, default: null },
  },
  { timestamps: true }
);

classSessionSchema.index({ teacher: 1, date: 1 });
classSessionSchema.index({ classGroup: 1, date: 1 });
classSessionSchema.index({ "recording.status": 1, "recording.available": 1 });

// Helper to get recording link for backward compatibility
classSessionSchema.virtual("effectiveRecordingLink").get(function() {
  // Prefer new recording.streamUrl if available, fallback to legacy recordingLink
  if (this.recording && this.recording.streamUrl) return this.recording.streamUrl;
  if (this.recording && this.recording.driveFileId) {
    // Generate view URL from file ID if needed
    return `https://drive.google.com/file/d/${this.recording.driveFileId}/view`;
  }
  return this.recordingLink || "";
});

// Helper to get recording status text for display
classSessionSchema.virtual("recordingStatusDisplay").get(function() {
  const status = this.recording?.status || "pending";
  const available = this.recording?.available || false;
  
  if (status === "available" && available) return "Available ✓";
  if (status === "processing") return "Processing...";
  if (status === "failed") return "Failed";
  if (status === "archived") return "Archived";
  return "Pending";
});

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
