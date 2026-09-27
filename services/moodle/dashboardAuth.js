// services/moodle/dashboardAuth.js
//
// Authentication + identity verification for the dashboard READ endpoints that
// Moodle consumes as a presentation layer. These are the SAME endpoints the
// React app uses:
//
//   GET /api/students/:studentId/{timetable,notifications,broadcasts}
//   GET /api/teachers/:id/{timetable,notifications,performance}
//   GET /api/teachers/teacher/broadcasts/:teacherId
//
// Two client types are accepted. Both MUST prove the very identity they ask
// for, so no client can read another user's dashboard:
//
//   1. Moodle  -> `Authorization: Bearer <MOODLE_DASHBOARD_TOKEN>` plus a signed
//      identity claim (X-Moodle-Identity/-Timestamp/-Nonce/-Signature). The
//      claim is HMAC-SHA256 over METHOD + PATH + IDENTITY + TIMESTAMP + NONCE,
//      keyed with the shared token, so the identity cannot be spoofed and a
//      captured claim cannot be re-aimed at another id or path.
//   2. React   -> the platform JWT issued by /api/{students,teachers}/login. Its
//      `id` must equal the requested id and its `role` must match the route.
//
// Anything else is rejected: 401 (missing/invalid/stale/replayed credential) or
// 403 (authenticated but wrong identity or wrong role). Every rejection is
// logged WITHOUT the token or signature.
import crypto from "crypto";
import logger from "../../utils/logger.js";

const asString = (v, fallback = "") => (v === undefined || v === null ? fallback : String(v).trim());
const PLACEHOLDER = /replace|change.?me|your[_-]/i;
/** Platform identity embedded in every StudiesMasters SSO username. */
export const IDENTITY_RE = /^sm_([st])_([0-9a-f]{24})$/;

// ---------------------------------------------------------------------------
// Settings (read at call time so tests + runtime rotation are honoured)
// ---------------------------------------------------------------------------

/** `enforce` (default) rejects; `monitor` logs the rejection but lets it pass. */
export function dashboardAuthMode() {
  return asString(process.env.MOODLE_DASHBOARD_AUTH_MODE, "enforce").toLowerCase() === "monitor"
    ? "monitor" : "enforce";
}

/** Replay-store backend: shared (Redis/Mongo via store.reserveNonce), memory, off. */
export function dashboardNonceStoreMode() {
  const mode = asString(process.env.MOODLE_DASHBOARD_NONCE_STORE, "shared").toLowerCase();
  return ["shared", "memory", "off"].includes(mode) ? mode : "shared";
}

/** Allowed clock drift (seconds) between Moodle and the backend. */
export function dashboardClockSkewSec() {
  const v = parseInt(process.env.MOODLE_DASHBOARD_CLOCK_SKEW || "300", 10);
  return Number.isFinite(v) && v > 0 ? v : 300;
}

/** How long a nonce stays "already seen" (replay window). */
export function dashboardNonceTtlSec() {
  const v = parseInt(process.env.MOODLE_DASHBOARD_NONCE_TTL || "", 10);
  if (Number.isFinite(v) && v > 0) return v;
  return dashboardClockSkewSec();
}

const isUsableSecret = (value) => {
  const v = asString(value);
  return Boolean(v) && !PLACEHOLDER.test(v) && v.length >= 16;
};

/** True only when a real (non-placeholder, >=16 char) token is configured. */
export function dashboardTokenConfigured() {
  return isUsableSecret(process.env.MOODLE_DASHBOARD_TOKEN);
}

/**
 * Fail-closed, timing-safe check of the shared Moodle dashboard token.
 * Mirrors verifyMainWebsiteSyncToken() so both integrations behave alike.
 */
export function verifyDashboardToken(candidate) {
  const expected = asString(process.env.MOODLE_DASHBOARD_TOKEN);
  if (!isUsableSecret(expected)) return { ok: false, reason: "not_configured" };
  const supplied = asString(candidate);
  if (!supplied) return { ok: false, reason: "missing_token" };
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid_token" };
  }
  return { ok: true };
}

/** Log-safe rendering of a secret (never the secret itself). */
export function maskSecret(value) {
  const v = asString(value);
  if (!v) return "(none)";
  return `${v.slice(0, 4)}***len${v.length}`;
}

/** Non-secret summary for docs/health output. */
export function dashboardAuthSummary() {
  return {
    mode: dashboardAuthMode(),
    tokenConfigured: dashboardTokenConfigured(),
    nonceStore: dashboardNonceStoreMode(),
    clockSkewSec: dashboardClockSkewSec(),
    signature: "HMAC-SHA256(token, METHOD\\nPATH\\nIDENTITY\\nTIMESTAMP\\nNONCE)",
  };
}

// ---------------------------------------------------------------------------
// Identity claim (signed by Moodle, verified here)
// ---------------------------------------------------------------------------

/** `sm_s_<24hex>` / `sm_t_<24hex>` -> { role, platformId }; null when not an SSO id. */
export function parseIdentity(identity) {
  const m = IDENTITY_RE.exec(asString(identity).toLowerCase());
  if (!m) return null;
  return { role: m[1] === "t" ? "teacher" : "student", platformId: m[2] };
}

/** Canonical string both sides sign (path = full path, query string excluded). */
export function identityClaimPayload({ method, path, identity, timestamp, nonce }) {
  return [
    asString(method).toUpperCase(),
    asString(path),
    asString(identity).toLowerCase(),
    asString(timestamp),
    asString(nonce),
  ].join("\n");
}

/** Moodle-side helper (also used by tests): produce the claim signature. */
export function signIdentityClaim({ method, path, identity, timestamp, nonce, secret }) {
  const key = asString(secret) || asString(process.env.MOODLE_DASHBOARD_TOKEN);
  return crypto.createHmac("sha256", key)
    .update(identityClaimPayload({ method, path, identity, timestamp, nonce }))
    .digest("hex");
}

/**
 * Verify a signed identity claim.
 *
 * @returns {{ok: true, role: string, platformId: string}|{ok: false, reason: string}}
 *   reasons: not_configured | invalid_identity | missing_timestamp |
 *            invalid_timestamp | stale_request | missing_nonce |
 *            missing_signature | invalid_signature
 */
export function verifyIdentityClaim({ method, path, identity, timestamp, nonce, signature, now = Date.now() }) {
  const expected = asString(process.env.MOODLE_DASHBOARD_TOKEN);
  if (!isUsableSecret(expected)) return { ok: false, reason: "not_configured" };

  const parsed = parseIdentity(identity);
  if (!parsed) return { ok: false, reason: "invalid_identity" };

  const rawTimestamp = asString(timestamp);
  if (!rawTimestamp) return { ok: false, reason: "missing_timestamp" };
  const numeric = Number(rawTimestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return { ok: false, reason: "invalid_timestamp" };
  const claimMs = numeric > 1e12 ? numeric : numeric * 1000; // accept s or ms
  if (Math.abs(now - claimMs) / 1000 > dashboardClockSkewSec()) {
    return { ok: false, reason: "stale_request" };
  }

  if (!asString(nonce)) return { ok: false, reason: "missing_nonce" };

  const supplied = asString(signature).toLowerCase();
  if (!supplied) return { ok: false, reason: "missing_signature" };
  const ours = crypto.createHmac("sha256", expected)
    .update(identityClaimPayload({ method, path, identity, timestamp, nonce }))
    .digest("hex");
  const a = Buffer.from(ours);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, ...parsed };
}

// ---------------------------------------------------------------------------
// Replay defence (single-use nonce)
// ---------------------------------------------------------------------------

/** In-process nonce memory (dev/test only — needs a single instance). */
const memoryNonces = new Map();

/** Test seam: forget what the in-process store has seen. */
export function resetDashboardNonceStore() {
  memoryNonces.clear();
}

function pruneMemory(ttlSec) {
  const cutoff = Date.now() - ttlSec * 1000;
  for (const [key, seenAt] of memoryNonces) {
    if (seenAt <= cutoff) memoryNonces.delete(key);
  }
}

/**
 * Admit a Moodle-minted nonce on its FIRST sight only.
 *
 * @returns {{ok: true, via: string}|{ok: false, reason: string}}
 *   reasons: replayed_nonce | nonce_store_unavailable
 */
export async function reserveDashboardNonce({ nonce, role, platformId }) {
  const mode = dashboardNonceStoreMode();
  if (mode === "off") return { ok: true, via: "off" };

  const ttlSec = dashboardNonceTtlSec();
  if (mode === "memory") {
    pruneMemory(ttlSec);
    if (memoryNonces.has(nonce)) return { ok: false, reason: "replayed_nonce" };
    memoryNonces.set(nonce, Date.now());
    return { ok: true, via: "memory" };
  }

  try {
    // Shared store reuses the SSO nonce collection/keyspace (Redis preferred).
    const { reserveNonce } = await import("./store.js");
    const result = await reserveNonce({ nonce, kind: role, studentRef: platformId });
    if (result && result.ok) return { ok: true, via: result.via || "shared" };
    return { ok: false, reason: "replayed_nonce" };
  } catch (err) {
    logger.error("[DASHBOARD-AUTH] nonce store unavailable", err?.message || String(err));
    return { ok: false, reason: "nonce_store_unavailable" };
  }
}

export default {
  dashboardAuthMode,
  dashboardTokenConfigured,
  verifyDashboardToken,
  parseIdentity,
  identityClaimPayload,
  signIdentityClaim,
  verifyIdentityClaim,
  reserveDashboardNonce,
  maskSecret,
  dashboardAuthSummary,
};
