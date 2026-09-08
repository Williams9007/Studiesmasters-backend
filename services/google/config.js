// services/google/config.js
//
// Centralised, validated configuration for the StudiesMasters <-> Google Meet
// integration. Follows the same conventions as services/moodle/config.js:
//   - Environment variables only (no hardcoded secrets, never committed).
//   - Lazy validation so importing this module never crashes the server when
//     Google is not yet configured.
//   - A development "mock" mode (GOOGLE_ALLOW_MOCK=true, default in dev) lets
//     the scheduling flow be exercised end-to-end without live credentials;
//     set GOOGLE_ALLOW_MOCK=false in production so a missing backend call is a
//     hard error instead of a silently generated link.
import dotenv from "dotenv";

dotenv.config();

const asString = (v, fallback = "") => (v === undefined || v === null ? fallback : String(v).trim());
const isTrue = (v, fallback = false) => {
  if (v === undefined || v === null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
};

export const config = {
  // Master switch. When false the Google layer is treated as "not configured"
  // and scheduling falls back to "meeting pending" (never blocks class creation).
  enabled: isTrue(process.env.GOOGLE_ENABLED, true),

  // ---- OAuth 2.0 (Google Cloud -> Credentials -> OAuth Client ID) ----
  clientId: asString(process.env.GOOGLE_CLIENT_ID),
  clientSecret: asString(process.env.GOOGLE_CLIENT_SECRET),
  redirectUri: asString(process.env.GOOGLE_REDIRECT_URI),
  projectId: asString(process.env.GOOGLE_PROJECT_ID),

  // Service account JSON key material (optional; used for domain-wide delegation).
  serviceAccount: asString(process.env.GOOGLE_SERVICE_ACCOUNT),

  // Encryption key used to encrypt Google tokens at rest. Must be >= 32 bytes
  // for AES-256-GCM. Never commit this.
  tokenEncKey: asString(process.env.GOOGLE_TOKEN_ENC_KEY),

  // ---- Behaviour ----
  // When true and no valid token / credentials are available, createMeeting()
  // returns a deterministic mock Meet payload so the full flow stays testable.
  // Set false in production to force a real integration.
  allowMock: isTrue(process.env.GOOGLE_ALLOW_MOCK, true),

  // Calendar + Meet API base.
  calendarBaseUrl: asString(process.env.GOOGLE_CALENDAR_BASE_URL, "https://www.googleapis.com/calendar/v3"),
  scopes: asString(process.env.GOOGLE_SCOPES, "https://www.googleapis.com/auth/calendar.events openid"),
  timezone: asString(process.env.GOOGLE_TIMEZONE, "UTC"),

  // HTTP timeouts / retries (kept in the same spirit as moodle config).
  timeoutMs: parseInt(process.env.GOOGLE_TIMEOUT_MS || "10000", 10),
  retries: parseInt(process.env.GOOGLE_RETRIES || "2", 10),
};

// Shared envelope helper. Real OAuth secrets may also be read at request time by
// token.service so this list is intentionally non-exhaustive.
export const requiredGoogle = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];
export const requiredEncryption = "GOOGLE_TOKEN_ENC_KEY";

/**
 * Validate that the Google layer is usable for a *real* integration.
 * Only called when we are about to talk to Google, never on import.
 * Throws with a clear message listing what is missing.
 */
export function assertConfiguredReal() {
  if (!config.enabled) {
    throw new Error("Google Meet integration is disabled (GOOGLE_ENABLED=false)");
  }
  const missing = requiredGoogle.filter((k) => !asString(process.env[k]));
  if (missing.length) {
    const err = new Error(`Google config is missing required variables: ${missing.join(", ")}`);
    err.code = "GOOGLE_NOT_CONFIGURED";
    throw err;
  }
  if (config.tokenEncKey.length < 32) {
    const err = new Error(`${requiredEncryption} must be at least 32 characters for AES-256-GCM at-rest encryption`);
    err.code = "GOOGLE_NOT_CONFIGURED";
    throw err;
  }
  return true;
}

/** True when the layer is configured enough for a real call (credentials + enc key). */
export function isConfiguredReal() {
  try {
    assertConfiguredReal();
    return true;
  } catch {
    return false;
  }
}

/** Should we fall back to a mock Meet link when a real call is not possible? */
export function canFallbackToMock() {
  return config.enabled && config.allowMock;
}

export default config;