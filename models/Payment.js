import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student", // Ensure this references your Student model
      required: true,
    },

    studentName: {
      type: String, // added for quick access in admin dashboard
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
      required: true, // array of subjects paid for
    },

    duration: {
      type: String,
      required: true, // e.g., "3 months", "6 months"
    },
    
    
    screenshot: { 
      data:Buffer,
      contentType: String,
    },



    amount: {
      type: Number,
      required: true,
    },

    referenceName: {
      type: String,
      required: true,
    },

    screenshot: {
      type: String, // file path or URL
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
      ref: "Admin", // which admin confirmed or rejected
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Payment", paymentSchema);
