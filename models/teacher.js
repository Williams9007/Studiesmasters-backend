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

    // ---- Google Meet Co-host Fields (Phase 6E) ----
    // Teacher's personal Google account for Meet co-host access.
    // This is for VERIFICATION ONLY - we do NOT store refresh tokens.
    // The teacher verifies ownership via Google OAuth Sign-In (openid scope).
    googleMeetEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      match: [/^[^@]+@[^@]+\.[^@]+$/, "Invalid Google Meet email format"],
    },
    googleAccountVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    googleVerifiedAt: {
      type: Date,
      default: null,
    },
    // Tracks the verification state for the OAuth flow
    googleOAuthState: {
      type: String,
      enum: ["not_connected", "pending", "verified", "disconnected"],
      default: "not_connected",
    },
    googleOAuthNonce: { type: String, default: null, select: false },
    googleOAuthStateExpiresAt: { type: Date, default: null, select: false },


    resetTokenExpiry: Date,
  },
  { timestamps: true }
);

// ---- Indexes for Google Meet queries (Phase 6E) ----
teacherSchema.index({ googleMeetEmail: 1 }, { unique: true, sparse: true });
teacherSchema.index({ email: 1, googleMeetEmail: 1 });

export default mongoose.models.Teacher || mongoose.model("Teacher", teacherSchema);
