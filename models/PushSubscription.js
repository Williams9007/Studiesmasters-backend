// PushSubscription.js — durable Web Push subscriptions (survives restarts,
// unlike the previous in-memory Set in the push controller).
import mongoose from "mongoose";

const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    role: { type: String, enum: ["student", "teacher", "qao", "admin"], default: null },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, default: "" },
      auth: { type: String, default: "" },
    },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

pushSubscriptionSchema.index({ userId: 1 });
pushSubscriptionSchema.index({ role: 1 });

const PushSubscription =
  mongoose.models.PushSubscription ||
  mongoose.model("PushSubscription", pushSubscriptionSchema);

export default PushSubscription;
