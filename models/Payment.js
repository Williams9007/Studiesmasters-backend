import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },

    studentName: {
      type: String,
    },

    curriculum: {
      type: String,
      enum: ["GES", "CAMBRIDGE"],
      required: true,
    },

    package: {
      type: String,
      required: true,
    },

    grade: {
      type: String,
    },

    subjects: {
      type: [String],
      required: true,
    },

    duration: {
      type: String,
      required: true,
    },

    screenshot: {
      type: String, // use either file path or URL
      required: true,
    },

    amount: {
      type: Number,
      required: true,
    },

    referenceName: {
      type: String,
      required: true,
    },

    transactionDate: {
      type: Date,
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "confirmed", "rejected"],
      default: "pending",
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  { timestamps: true }
);

// ✅ Prevent OverwriteModelError
const Payment = mongoose.models.Payment || mongoose.model("Payment", paymentSchema);

export default Payment;
