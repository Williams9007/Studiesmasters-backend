import mongoose from "mongoose";

// Teacher leave requests. QAO reviews; teachers submit and can cancel their
// own pending requests. Reviewer is always a Tutor Manager (QaoUser).
const leaveRequestSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true, index: true },
    leaveType: {
      type: String,
      enum: ["sick", "vacation", "personal", "emergency", "other"],
      required: true,
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    reason: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "QaoUser", default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, default: "" },
    // Who created the request (teacher self-service or QAO on behalf)
    submittedBy: { type: String, enum: ["teacher", "qao"], default: "teacher" },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ teacher: 1, startDate: 1 });

export default mongoose.models.LeaveRequest || mongoose.model("LeaveRequest", leaveRequestSchema);
