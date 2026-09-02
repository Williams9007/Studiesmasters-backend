// models/SsoNonce.js
//
// One-time login token storage (MongoDB fallback store).
//
// Used when REDIS_URL is not configured. The nonce is a random high-entropy
// string baked into the signed SSO URL. On first use it is atomically claimed;
// any later attempt to reuse it is rejected (replay protection). A MongoDB TTL
// index auto-deletes entries after 5 minutes so stale tokens cannot linger.
import mongoose from "mongoose";

const ssoNonceSchema = new mongoose.Schema(
  {
    nonce: { type: String, required: true, unique: true },
    studentRef: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: ["student", "teacher"], default: "student" },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Auto-expire 5 minutes after creation.
ssoNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.SsoNonce || mongoose.model("SsoNonce", ssoNonceSchema);