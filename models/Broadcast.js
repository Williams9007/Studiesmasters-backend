import mongoose from "mongoose";

const broadcastSchema = new mongoose.Schema({
  sender: {
    type: String,
    default: "admin",
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
    enum: ["Student", "Teacher", "Qao"],
  },
  message: {
    type: String,
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Broadcast", broadcastSchema);
