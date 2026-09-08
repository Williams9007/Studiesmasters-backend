// services/google/encryption.js
//
// AES-256-GCM encryption for Google tokens stored at rest. Used by
// token.service so refresh/access tokens are never held in plaintext in the
// database. The key comes from GOOGLE_TOKEN_ENC_KEY (config.js) and is never
// hardcoded.
import crypto from "crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce, recommended for GCM
const TAG_LEN = 128; // bits

function keyBytes() {
  const encKey = config.tokenEncKey || process.env.GOOGLE_TOKEN_ENC_KEY;
  if (!encKey || String(encKey).length < 32) {
    throw new Error("GOOGLE_TOKEN_ENC_KEY missing (must be >= 32 chars) for token-at-rest encryption");
  }
  // SHA-256 to safely normalise any key length down to a fresh 32-byte buffer.
  return crypto.createHash("sha256").update(String(encKey)).digest();
}

/**
 * Encrypt a UTF-8 string. Returns "v1:<iv-b64>:<ciphertext+tag b64>" or null
 * when there is nothing to encrypt.
 */
export function encryptValue(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === "") return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${Buffer.concat([ct, cipher.getAuthTag()]).toString("base64")}`;
}

/**
 * Decrypt a value produced by encryptValue(). Returns null on any failure so
 * callers can degrade gracefully instead of crashing.
 */
export function decryptValue(payload) {
  if (!payload || typeof payload !== "string") return null;
  try {
    const [version, ivB64, restB64] = String(payload).split(":", 3);
    if (version !== "v1" || !ivB64 || !restB64) return null;
    const iv = Buffer.from(ivB64, "base64");
    const combined = Buffer.from(restB64, "base64");
    if (combined.length < TAG_LEN / 8) return null;
    const tag = combined.subarray(combined.length - TAG_LEN / 8);
    const ct = combined.subarray(0, combined.length - TAG_LEN / 8);
    const decipher = crypto.createDecipheriv(ALGO, keyBytes(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Tampered / overwritten / wrong key -> treat as unavailable.
    return null;
  }
}

export default { encryptValue, decryptValue };