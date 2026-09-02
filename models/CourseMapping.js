// models/CourseMapping.js
//
// Centralised, runtime-configurable mapping from a StudiesMasters subject /
// package / grade to one or more Moodle course ids. The course mapping layer
// (services/moodle/courseMapper.js) reads exclusively from this collection so
// adding or re-pointing a course never requires a code change or redeploy.
//
// Replace the legacy per-Subject `moodleCourseId` field; kept admin-editable via
// the same admin UI (writes are also persisted back to Subject for backward
// compatibility during transition).
import mongoose from "mongoose";

const mappingTargetSchema = new mongoose.Schema(
  {
    moodleCourseId: { type: Number, required: true },
    roleShortName: { type: String, default: "student" }, // role id or shortname in Moodle
    // Moodle category this course lives in (populated by auto-provisioning).
    categoryId: { type: Number, default: null },
  },
  { _id: false }
);

const courseMappingSchema = new mongoose.Schema(
  {
    // Selection key — the more specific fields set, the more specific match.
    subjectName: { type: String, trim: true, default: null }, // e.g. "Mathematics"
    packageName: { type: String, trim: true, default: null }, // e.g. "Home Tuition"
    curriculum: { type: String, trim: true, default: null }, // "GES" | "CAMBRIDGE" | "SAT" | "GCE"
    grade: { type: String, trim: true, default: null },

    targets: [mappingTargetSchema],

    enabled: { type: Boolean, default: true },
    createdBy: { type: String, default: "system" },
  },
  { timestamps: true }
);

// Prevent ambiguous duplicate lookups.
courseMappingSchema.index(
  { subjectName: 1, packageName: 1, curriculum: 1, grade: 1 },
  { unique: true }
);

export default mongoose.models.CourseMapping || mongoose.model("CourseMapping", courseMappingSchema);