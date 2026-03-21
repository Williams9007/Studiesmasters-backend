// models/MessageRecipient.js
import mongoose from "mongoose";

const messageRecipientSchema = new mongoose.Schema(
  {
    message: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isRead: { type: Boolean, default: false },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

messageRecipientSchema.index({ recipient: 1 });
messageRecipientSchema.index({ message: 1 });
messageRecipientSchema.index({ message: 1, recipient: 1 }, { unique: true });

export default mongoose.models.MessageRecipient ||
  mongoose.model("MessageRecipient", messageRecipientSchema);
