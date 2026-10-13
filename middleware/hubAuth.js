// middleware/hubAuth.js
//
// Auth for the Moodle StudiesMasters Hub dashboard endpoints. These are GET
// endpoints that the Moodle plugin calls server-to-server; Moodle cannot hold a
// JWT, so it authenticates exactly like the SSO handshake - a shared bearer
// token plus an HMAC request signature - and the backend re-resolves the
// principal from the immutable platform id, never trusting a client body.
//
// Every request must carry:
//   Authorization: Bearer <MOODLE_DASHBOARD_TOKEN>       (the shared token)
//   X-Moodle-Identity: sm_s_<24-hex> | sm_t_<24-hex>     (Moodle username; the
//                     hex is the immutable Mongo _id)
//   X-Moodle-Timestamp: epoch seconds
//   X-Moodle-Nonce: one-time random token
//   X-Moodle-Signature: HMAC-SHA256("GET|path|identity|timestamp|nonce", token)
//
// On any failure this logs the exact reason (bad bearer vs bad HMAC vs
// stale/replayed) so a 401 is diagnosable in seconds - a mismatch here is the
// classic "students get 401 while teachers 200" symptom when the configured
// token differs by even one character from the Moodle Site Admin setting.
import crypto from "crypto";

// A token that is unset, a placeholder, or too short is treated as "not
// configured" (fail closed) - never silently accepted.
function isPlaceholder(token) {
  return /replace|change.?me|your[_-].*token|example|xxx+/i.test(token);
}

function expectedToken() {
  const t = String(process.env.MOODLE_DASHBOARD_TOKEN || "").trim();
  if (!t || t.length < 16 || isPlaceholder(t)) return "";
  return t;
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Validate the shared bearer token in isolation so a caller (and the logs) can
 * distinguish "wrong token" from "token fine but signature bad".
 * Returns { ok, reason } with reason in { not_configured, missing_token,
 * invalid_token }.
 */
export function verifyHubToken(candidate) {
  const expected = expectedToken();
  if (!expected) return { ok: false, reason: "not_configured" };
  const supplied = String(candidate || "").trim();
  if (!supplied) return { ok: false, reason: "missing_token" };
  if (!timingSafeEqualStr(supplied, expected)) return { ok: false, reason: "invalid_token" };
  return { ok: true };
}

/** Pull the raw bearer value from the Authorization header. */
export function bearerFrom(req) {
  const auth = String(req.get("Authorization") || "").trim();
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

const HEARTBEAT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const usedNonces = new Map(); // nonce -> first-seen epoch ms

/** One-time nonce guard (in-memory). Restart clears it, which only ever risks a
 *  brief replay window; correctness for replay *within* the window holds. */
function reserveNonce(nonce) {
  const now = Date.now();
  for (const [n, at] of usedNonces) if (now - at > HEARTBEAT_TTL_MS) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, now);
  return true;
}

/** Build the exact string that was signed, so both sides agree without doubt. */
export function hubSignaturePayload({ method, path, identity, timestamp, nonce }) {
  return `${method}|${path}|${identity}|${timestamp}|${nonce}`;
}

/**
 * Verify the request signature. Accepts the signing token explicitly so the
 * caller validates the bearer first (and logs which half failed).
 */
export function verifyHubSignature({ method, path, identity, timestamp, nonce, signature, token }) {
  const expected = expectedToken();
  if (!expected) return { ok: false, reason: "not_configured" };
  const secret = String(token || "").trim();
  if (!secret || !timingSafeEqualStr(secret, expected)) return { ok: false, reason: "invalid_token" };
  if (!identity || !timestamp || !nonce || !signature) return { ok: false, reason: "missing_fields" };

  const payload = hubSignaturePayload({ method, path, identity, timestamp, nonce });
  const computed = crypto.createHmac("sha256", expected).update(payload).digest("hex");
  if (!timingSafeEqualStr(String(signature).toLowerCase(), computed.toLowerCase())) {
    return { ok: false, reason: "bad_hmac" };
  }

  // Freshness (+/-5 min) + replay, checked only after the signature proves the
  // timestamp/nonce are authentic (otherwise a client could force expiry).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (!reserveNonce(nonce)) return { ok: false, reason: "replayed_nonce" };

  return { ok: true };
}

/**
 * Express middleware. Resolves req.hub = { role, platformId } from
 * X-Moodle-Identity and enforces the full token+signature contract. Every
 * rejection is logged with its precise reason.
 *
 * NOTE on the signed path: the plugin signs the request route path (e.g.
 * "/api/students/6a62.../timetable"), which is exactly req.baseUrl + req.path.
 * The query string is NOT part of the signature.
 */
export function hubAuth(req, res, next) {
  const path = req.baseUrl + req.path;
  const method = req.method;
  const identity = String(req.get("X-Moodle-Identity") || "").trim();
  const timestamp = String(req.get("X-Moodle-Timestamp") || "").trim();
  const nonce = String(req.get("X-Moodle-Nonce") || "").trim();
  const signature = String(req.get("X-Moodle-Signature") || "").trim();

  // 1) Shared bearer token - checked first so the logs name this precisely.
  const token = bearerFrom(req);
  const tokenCheck = verifyHubToken(token);
  if (!tokenCheck.ok) {
    console.warn(`[hubAuth] 401 bearer ${tokenCheck.reason} - ${method} ${path} identity=${identity || "(none)"} ` +
      `(verify MOODLE_DASHBOARD_TOKEN exactly matches Moodle Site Admin -> StudiesMasters Hub -> dashboard API token)`);
    return res.status(tokenCheck.reason === "not_configured" ? 503 : 401).json({
      success: false,
      error: tokenCheck.reason === "not_configured" ? "dashboard_api_not_configured" : "invalid_token",
      reason: tokenCheck.reason,
    });
  }

  // 2) Identity -> platformId + role.
  const m = /^sm_(s|t)_([a-f\d]{24})$/i.exec(identity);
  if (!m) {
    console.warn(`[hubAuth] 401 invalid_identity - ${method} ${path} identity=${identity || "(none)"}`);
    return res.status(401).json({ success: false, error: "invalid_identity", reason: "bad_identity" });
  }

  // 3) Signature (HMAC + freshness + replay).
  const sigCheck = verifyHubSignature({ method, path, identity, timestamp, nonce, signature, token });
  if (!sigCheck.ok) {
    console.warn(`[hubAuth] 401 ${sigCheck.reason} - ${method} ${path} identity=${identity}`);
    return res.status(401).json({ success: false, error: "unauthorized", reason: sigCheck.reason });
  }

  req.hub = { role: m[1].toLowerCase() === "s" ? "student" : "teacher", platformId: m[2].toLowerCase() };
  return next();
}

export default hubAuth;

