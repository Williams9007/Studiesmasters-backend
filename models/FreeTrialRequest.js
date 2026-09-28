import mongoose from "mongoose";

// Public "book a free trial" requests coming from the marketing site.
// The form used to console.log + alert() with no persistence, so every
// submission was lost. Each request is stored here so the admin team can
// work the lead queue and contact the parent on WhatsApp/phone.
const freeTrialRequestSchema = new mongoose.Schema(
  {
    // Student
    studentName: { type: String, required: true, trim: true, maxlength: 120 },
    grade: { type: String, required: true, trim: true, maxlength: 40 },
    subjects: { type: [String], default: [] },

    // Parent / guardian
    parentName: { type: String, required: true, trim: true, maxlength: 120 },
    whatsapp: { type: String, required: true, trim: true, maxlength: 32 },
    alternativePhone: { type: String, trim: true, default: "", maxlength: 32 },

    // Scheduling preferences
    preferredDays: { type: [String], default: [] },
    preferredTime: { type: String, trim: true, default: "", maxlength: 40 },

    // Optional
    goals: { type: [String], default: [] },

    // Consent to be contacted via WhatsApp/phone
    consent: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ["new", "contacted", "booked", "completed", "cancelled"],
      default: "new",
      index: true,
    },

    // Admin follow-up
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, default: "" },

    // Where the lead came from, e.g. "website".
    source: { type: String, trim: true, default: "website" },
  },
  { timestamps: true }
);

// Admin list is "newest first, filtered by status".
freeTrialRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.FreeTrialRequest ||
  mongoose.model("FreeTrialRequest", freeTrialRequestSchema);