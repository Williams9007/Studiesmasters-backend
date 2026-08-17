import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ["info", "alert", "warning", "broadcast"], default: "info" },
  read: { type: Boolean, default: false },
  // Optional link attached by admin
  link: { type: String, trim: true, default: null },
  // Optional attachment path from the broadcast
  attachment: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
