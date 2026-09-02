// services/moodle/config.js
//
// Centralised, validated configuration for the StudiesMasters ↔ Moodle hub.
// Every Moodle-facing behaviour reads from here so settings are validated once,
// secrets can be rotated (kid-indexed), and the rest of the services stay
// declarative.
//
// Secret rotation:
//   MOODLE_SSO_SECRET        -> current primary signing secret
//   MOODLE_SSO_SECRETS_JSON  -> optional array of C<{ id, secret, active }>
//   MOODLE_SSO_ACTIVE_KEY_ID -> optional; which id to sign with (defaults to "1"
//                               / the newest active). Verification tries all.
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const asString = (v, fallback = "") => (v === undefined || v === null ? fallback : String(v).trim());

// ---- Required-flag validation -------------------------------------------
const requiredMoodle = ["MOODLE_SSO_SECRET", "MOODLE_BASE_URL"];
const missing = requiredMoodle.filter((k) => !process.env[k]);
if (missing.length && String(process.env.MOODLE_REQUIRED) === "true") {
  throw new Error(`Moodle config is missing required variables: ${missing.join(", ")}`);
}

// ---- Secret rotation helpers --------------------------------------------
function collectSecrets() {
  const primary = asString(process.env.MOODLE_SSO_SECRET);
  const list = [];
  if (primary) list.push({ id: asString(process.env.MOODLE_SSO_ACTIVE_ID) || "1", secret: primary });

  // Optional extra verification secrets (older keys still accepted for verify,
  // so a rotation doesn't log everyone out).
  try {
    const j = process.env.MOODLE_SSO_SECRETS ? JSON.parse(asString(process.env.MOODLE_SSO_SECRETS)) : [];
    const activeId = asString(process.env.MOODLE_SSO_ACTIVE_ID) || "1";
    for (const e of Array.isArray(j) ? j : []) {
      if (e && typeof e.secret === "string" && e.secret) list.push({ id: asString(e.id) || activeId, secret: e.secret });
    }
  } catch { /* malformed rotation JSON -> just use primary */ }

  // De-duplicate by id (primary wins).
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// Secrets are collected lazily so rotation env vars set after the module was
// first imported (e.g. in tests or a hot-reload) are still honoured.
let cachedSecrets = null;
function getSecrets() {
  if (!cachedSecrets) cachedSecrets = collectSecrets();
  return cachedSecrets;
}

export const secrets = new Proxy([], {
  get(_t, prop) {
    if (prop === "refresh") {
      return () => { cachedSecrets = null; return getSecrets(); };
    }
    return Reflect.get(getSecrets(), prop);
  },
  ownKeys() { return Reflect.ownKeys(getSecrets()); },
  getOwnPropertyDescriptor(_t, prop) {
    return Object.getOwnPropertyDescriptor(getSecrets(), prop);
  },
});

export function isValidSecretConfigured() {
  const s = getSecrets();
  return s.length > 0 && s[0].secret.length >= 16;
}

export const config = {
  enabled: String(process.env.MOODLE_ENABLED || "true") === "true",

  // Wire end-points
  baseUrl: asString(process.env.MOODLE_BASE_URL).replace(/\/$/, ""),
  ssoPath: (() => {
    const p = asString(process.env.MOODLE_SSO_PATH, "/local/studiesmasters_sso/sso.php");
    return p.startsWith("/") ? p : `/${p}`;
  })(),
  ssoLifetimeMs: parseInt(process.env.MOODLE_SSO_LIFETIME_MS || "300000", 10), // 5 min
  ssoClockSkewSec: parseInt(process.env.MOODLE_SSO_CLOCK_SKEW || "300", 10),

  // REST Web Services (the backend is the only authority).
  wsEnabled: String(process.env.MOODLE_WS_ENABLED || "false") === "true",
  wsUrl: asString(process.env.MOODLE_WS_URL) || `${asString(process.env.MOODLE_BASE_URL)}/webservice/rest/server.php`,
  wsToken: asString(process.env.MOODLE_WS_TOKEN),
  dryRun: String(process.env.MOODLE_DRY_RUN || "true") === "true",

  // Technical limits
  wsTimeoutMs: parseInt(process.env.MOODLE_WS_TIMEOUT_MS || "10000", 10),
  wsRetries: parseInt(process.env.MOODLE_WS_RETRIES || "3", 10),
  wsRetryBackoffMs: parseInt(process.env.MOODLE_WS_RETRY_BACKOFF_MS || "1000", 10),

  // Nonce / one-time-token store
  redisUrl: asString(process.env.REDIS_URL), // if set, Redis is preferred for nonces
  nonceTtlSec: Math.floor((parseInt(process.env.MOODLE_SSO_LIFETIME_MS || "300000", 10)) / 1000) || 300,

  // Background reconciliation
  reconEnabled: String(process.env.MOODLE_RECONCILIATION_ENABLED || "false") === "true",
  reconIntervalMs: parseInt(process.env.MOODLE_RECONCILIATION_INTERVAL_MS || "3600000", 10), // hourly
  autoSync: String(process.env.MOODLE_AUTO_SYNC || "false") === "true",
  jwtSecret: asString(process.env.JWT_SECRET),
  auditToDb: String(process.env.MOODLE_AUDIT_DB || "true") === "true",
  adminAlert: String(process.env.MOODLE_ADMIN_ALERT || "false") === "true",
};

// Sign a payload with the primary/active secret.
export function signPayload(payload) {
  const s = getSecrets()[0];
  return { sign: crypto.createHmac("sha256", s.secret).update(payload).digest("hex"), kid: s.id };
}

// Verify against every configured secret (timing-safe). Returns true if any matches.
// Recomputes the secret list each call so runtime rotation is always honoured.
export function verifyPayload(payload, expectedHex) {
  const expected = String(expectedHex || "").toLowerCase();
  if (!expected) return { ok: false };
  for (const s of collectSecrets()) {
    const ours = crypto.createHmac("sha256", s.secret).update(payload).digest("hex");
    const a = Buffer.from(ours, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true, matchedId: s.id };
  }
  return { ok: false };
}

export default config;