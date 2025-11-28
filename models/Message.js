// models/Message.js
import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // or "Admin" if QAO is in a separate collection
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    senderRole: { type: String, enum: ["admin", "teacher", "student", "qao"], required: true },
    receiverRole: { type: String, enum: ["admin", "teacher", "student", "qao"], required: true },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model("Message", messageSchema);
