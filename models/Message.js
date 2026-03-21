// models/Message.js
import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

messageSchema.index({ createdAt: -1 });

export default mongoose.models.Message ||
  mongoose.model("Message", messageSchema);
