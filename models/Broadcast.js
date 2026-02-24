import mongoose from "mongoose";

const broadcastSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },

    type: {
      type: String,
      enum: ["students", "teachers", "qaos", "all", "single"],
      default: "all",
    },

    recipients: [
      {
        type: mongoose.Schema.Types.ObjectId,
        refPath: "recipientModel",
      },
    ],

    recipientModel: {
      type: String,
      enum: ["Student", "Teacher", "QaoUser"], // FIXED
    },

    subject: {
      type: String,
    },

    message: {
      type: String,
      required: true,
    },

    recipientsCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Broadcast", broadcastSchema);
