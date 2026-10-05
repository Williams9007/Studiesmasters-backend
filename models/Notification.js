import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema({
  // Optional: role-wide broadcasts (notifyAllTeachers / notifyAllQaos) have no
  // single recipient and store userId = null (they are queried by role).
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  // Role of the recipient - allows querying by role and scoping payloads.
  role: { type: String, enum: ["qao", "teacher", "student", "admin"], default: "teacher" },
  title: { type: String, trim: true, default: "" },
  message: { type: String, required: true },
  type: { type: String, enum: ["info", "alert", "warning", "broadcast"], default: "info" },
  read: { type: Boolean, default: false },
  // Optional link attached by admin
  link: { type: String, trim: true, default: null },
  // Optional attachment path from the broadcast
  attachment: { type: String, default: null },
  // Originating class group, when the notification is about a specific class.
  // Used as a permission gate: a student only ever sees notifications whose
  // classGroupId is one of their ASSIGNED, active class groups, so a class
  // group's schedule / Meet link can never leak to another group.
  classGroupId: { type: mongoose.Schema.Types.ObjectId, ref: "ClassGroup", default: null },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "ClassSession", default: null },
  createdAt: { type: Date, default: Date.now },
});

// Optimized lookups: per-user unread, per-user recent history, per-role lists
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ role: 1, createdAt: -1 });

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
