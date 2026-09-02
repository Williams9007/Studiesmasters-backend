// models/MoodleLink.js
//
// The authoritative accounting of how a StudiesMasters principal maps onto a
// Moodle user. MongoDB is the single source of truth; this document records the
// Moodle identity derived from it (stable username from the immutable _id /
// userId) plus the last-known Moodle numeric user id and sync metadata.
//
// Email is intentionally NOT the identity key. A student's email can change and
// the Moodle username (moodleUsername) stays stable, satisfying the "stable
// identity" requirement.
import mongoose from "mongoose";

const moodleLinkSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["student", "teacher"], required: true },
    studentRef: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
    teacherRef: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", default: null },

    // Stable identity -> the Moodle username. Derived once from the immutable id
    // (e.g. `sm_<ObjectId hex>` or `sm_st_<userId>`). Never derived from email.
    moodleUsername: { type: String, required: true, unique: true, index: true },

    // Filled after the first successful Moodle WS create; null if not created yet.
    moodleUserId: { type: Number, default: null },
    email: { type: String, trim: true, lowercase: true },

    // Account lifecycle state mirrored to Moodle.
    suspended: { type: Boolean, default: false },
    active: { type: Boolean, default: true },

    // Cache of the course ids (Moodle) this user is enrolled in.
    enrolledCourseIds: [{ type: Number }],

    lastSyncedProfileAt: { type: Date, default: null },
    lastEnrollSyncAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    loginCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Composite uniqueness so students and teachers cannot collide on the same refs.
moodleLinkSchema.index({ studentRef: 1 }, { unique: true, sparse: true });
moodleLinkSchema.index({ teacherRef: 1 }, { unique: true, sparse: true });

export default mongoose.models.MoodleLink || mongoose.model("MoodleLink", moodleLinkSchema);