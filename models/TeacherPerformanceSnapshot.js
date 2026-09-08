import mongoose from "mongoose";

// Teacher performance snapshot - computed from ClassSession (source of truth),
// never manually edited. Captures a period's operational metrics for one teacher.
const teacherPerformanceSnapshotSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true, index: true },
    period: {
      // "YYYY-MM" month key this snapshot covers
      month: { type: String, required: true, index: true },
    },
    // Session outcome counts (from ClassSession status)
    completedClasses: { type: Number, default: 0 },
    cancelledClasses: { type: Number, default: 0 },
    // Sessions the teacher covered as a substitute
    substitutedClasses: { type: Number, default: 0 },
    // Total teaching minutes -> stored for the snapshot (computed from sessions)
    teachingHours: { type: Number, default: 0 },
    // cancelled / (completed + cancelled), percentage 0-100
    cancellationRate: { type: Number, default: 0 },
    // Fraction of scheduled slots where availability covered them (0-100)
    availabilityRate: { type: Number, default: 100 },
    // Weighted 0-100 balancing score (workload distribution)
    workloadScore: { type: Number, default: 0 },
    workloadLevel: {
      type: String,
      enum: ["underloaded", "balanced", "heavy", "overloaded"],
      default: "balanced",
    },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One snapshot per teacher per month
teacherPerformanceSnapshotSchema.index({ teacher: 1, month: 1 }, { unique: true });

export default mongoose.models.TeacherPerformanceSnapshot ||
mongoose.model("TeacherPerformanceSnapshot", teacherPerformanceSnapshotSchema);