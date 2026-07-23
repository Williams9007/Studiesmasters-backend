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
      default: "",
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

    paymentProvider: {
      type: String,
      enum: ["manual", "paystack"],
      default: "manual",
    },

    paystackReference: {
      type: String,
      sparse: true,
      unique: true,
    },

    paymentPurpose: {
      type: String,
      enum: ["new", "renewal", "upgrade"],
      default: "new",
    },

    addOns: [{ type: String }],

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
