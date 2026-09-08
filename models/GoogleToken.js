// models/GoogleToken.js
//
// Encrypted-at-rest storage for Google OAuth tokens. Access and refresh tokens
// are never stored in plaintext: token.service encrypts them with
// services/google/encryption.js (key = GOOGLE_TOKEN_ENC_KEY) before persisting,
// and decrypts just before use.
import mongoose from "mongoose";

const googleTokenSchema = new mongoose.Schema(
  {
    provider: { type: String, default: "google", index: true },
    email: { type: String, default: null, index: true }, // account the token belongs to

    // Encrypted token material (encryptValue output, e.g. "v1:iv:ct+tag").
    encryptedAccessToken: { type: String, default: null },
    encryptedRefreshToken: { type: String, default: null },

    tokenType: { type: String, default: "Bearer" },
    scope: { type: String, default: "" },
    expiresAt: { type: Date, default: null },

    // OAuth2 state nonce for the authorization-code flow (short lived).
    authState: { type: String, default: null },
    authStateExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Only one live token row per account / provider at a time.
googleTokenSchema.index({ provider: 1, email: 1 }, { unique: true, sparse: true });

export default mongoose.models.GoogleToken || mongoose.model("GoogleToken", googleTokenSchema);