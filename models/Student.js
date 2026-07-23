import mongoose from "mongoose";
const studentSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    // Public registration identifier. This is separate from MongoDB's internal _id.
    // `sparse` allows older accounts to be backfilled safely after deployment.
    userId: {
  type: String,
  required: true,
  unique: true,
  immutable: true,
  index: true
},
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, required: true },
    password: { type: String, required: true, minlength: 6 },
    curriculum: {
      type: String,
      enum: ["GES", "CAMBRIDGE", "SAT", "GCE"],
      required: true,
    },
    package: { type: String },
    practice: { type: String },
    selectedPlan: { type: String, default: "" },
    grade: { type: String },
    totalAmount: { type: Number, default: 0 },
    studyDuration: { type: String, default: "" },
    preferredDays: [{ type: String }],
    preferredTime: { type: String, default: "" },
    policyAcceptance: {
      terms: { type: Boolean, default: false },
      privacy: { type: Boolean, default: false },
      parentAgreement: { type: Boolean, default: false },
      acceptedAt: { type: Date, default: null },
    },
    startDate: { type: Date, default: null },
    finishDate: { type: Date, default: null },
    subjectsEnrolled: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
    subjectNames: [{ type: String, trim: true }],
    assignmentsSubmitted: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Assignment" },
    ],
    resetToken: { type: String },
    resetTokenExpiry: { type: Date },
  },
  { timestamps: true }
);

const Student = mongoose.models.Student || mongoose.model("Student", studentSchema);

export default Student;
