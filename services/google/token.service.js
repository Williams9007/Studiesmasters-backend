// services/google/token.service.js
//
// Google OAuth token management:
//   - Stores access/refresh tokens ENCRYPTED at rest (models/GoogleToken.js).
//   - Refreshes an expiring access token via the Google token endpoint.
//   - Never exposes secret material to callers — returns a plaintext token
//     only inside a short-lived callback (getAccessToken) bounded to a single
//     API call, so secrets are not handed around the codebase.
//   - Follows services/moodle convention: import-safe, lazy, never crashes the
//     server on config issues.
import crypto from "crypto";
import GoogleToken from "../../models/GoogleToken.js";
import { config, isConfiguredReal } from "./config.js";
import { encryptValue, decryptValue } from "./encryption.js";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

function stateSecret() {
  const secret = process.env.JWT_SECRET || config.tokenEncKey;
  if (!secret || secret.length < 32) {
    throw new Error("Google OAuth state secret must be at least 32 characters");
  }
  return secret;
}

function encodeStatePart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeStatePart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

/** Create a signed, expiring state that is safe across stateless app instances. */
export function createSignedOAuthState(email = null) {
  const payload = {
    nonce: crypto.randomBytes(24).toString("hex"),
    email,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
  };
  const encoded = encodeStatePart(payload);
  const signature = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

/** Verify signature, expiry, and the expected service-account binding. */
export function verifySignedOAuthState(state, expectedEmail = null) {
  try {
    const [encoded, signature] = String(state || "").split(".");
    if (!encoded || !signature) throw new Error("Malformed OAuth state");
    const expectedSignature = crypto
      .createHmac("sha256", stateSecret())
      .update(encoded)
      .digest("base64url");
    const actual = Buffer.from(signature);
    const expected = Buffer.from(expectedSignature);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new Error("OAuth state signature mismatch");
    }
    const payload = decodeStatePart(encoded);
    if (!payload.nonce || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error("OAuth state expired");
    }
    if (expectedEmail && payload.email !== expectedEmail) {
      throw new Error("OAuth state account mismatch");
    }
    return payload;
  } catch (err) {
    const error = new Error("Invalid OAuth state");
    error.code = "GOOGLE_OAUTH_STATE_MISMATCH";
    error.detail = err.message;
    throw error;
  }
}

function hasExpired(row, skewSec = 60) {
  return row?.expiresAt && new Date(row.expiresAt).getTime() - skewSec * 1000 < Date.parse(new Date().toString());
}

/** Refresh an access token using the stored refresh token. */
async function refreshAccessToken(row, email) {
  if (!row.encryptedRefreshToken) {
    throw new Error(`No refresh token available for Google account ${email || "?"}`);
  }
  const refreshToken = decryptValue(row.encryptedRefreshToken);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  let res;
  try {
    res = await fetch(`${OAUTH_TOKEN_URL}?${body}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  } catch (err) {
    const e = new Error(`Google token refresh network error: ${err.message}`);
    e.code = "GOOGLE_TOKEN_REFRESH_FAILED";
    throw e;
  }

  if (!res.ok) {
    const err = new Error(`Google token refresh failed (${res.status})`);
    err.code = "GOOGLE_TOKEN_REFRESH_FAILED";
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    const err = new Error("Google token refresh returned no access_token");
    err.code = "GOOGLE_TOKEN_REFRESH_FAILED";
    throw err;
  }

  const updates = {
    encryptedAccessToken: encryptValue(data.access_token),
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000),
  };
  if (data.refresh_token) {
    updates.encryptedRefreshToken = encryptValue(data.refresh_token); // rotate
  }
  await GoogleToken.updateOne({ provider: "google", email }, { $set: updates }, { upsert: false });
  return decryptValue(updates.encryptedAccessToken);
}

/**
 * Resolve a usable plaintext access token for the default Google account.
 * Prefers a non-expired stored token, otherwise refreshes. Returns null when
 * no token is available (caller decides whether to fall back to mock).
 */
export async function getAccessToken({ email = null } = {}) {
  if (!isConfiguredReal()) return null;

  const row = email
    ? await GoogleToken.findOne({ provider: "google", email }).lean()
    : await GoogleToken.findOne({ provider: "google" }).sort({ updatedAt: -1 }).lean();
  if (!row) return null;

  try {
    if (row.encryptedAccessToken && !hasExpired(row)) {
      const token = decryptValue(row.encryptedAccessToken);
      if (token) return token;
    }
    return await refreshAccessToken(row, email || row.email);
  } catch {
    return null; // refresh failed -> caller falls back per GOOGLE_ALLOW_MOCK
  }
}

/**
 * Persist tokens returned by the authorization-code exchange. Values are
 * encrypted before they touch MongoDB.
 */
export async function saveToken({ email, accessToken, refreshToken, scope = "", expiresIn = 3600 }) {
  const payload = {
    provider: "google",
    email: email || null,
    encryptedAccessToken: encryptValue(accessToken),
    scope: scope || config.scopes,
    expiresAt: new Date(Date.now() + (Number(expiresIn) || 3600) * 1000),
  };
  if (refreshToken) payload.encryptedRefreshToken = encryptValue(refreshToken);

  await GoogleToken.updateOne({ provider: "google", email }, { $set: payload }, { upsert: true });
  return { ok: true, email };
}

/** Generate an OAuth2 authorization URL + persist a state nonce for validation. */
export async function beginAuthorization({ email = null } = {}) {
  const state = createSignedOAuthState(email);
  await GoogleToken.updateOne(
    { provider: "google", email },
    { $set: { authState: state, authStateExpiresAt: new Date(Date.now() + OAUTH_STATE_TTL_SECONDS * 1000) } },
    { upsert: true }
  );
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return { state, url: `https://accounts.google.com/o/oauth2/auth?${params}` };
}

/** Exchange the authorization code for tokens. */
export async function exchangeCode({ code, state, email = null }) {
  // State is signed and expires after 10 minutes. It is independent of the
  // single GoogleToken row, so parallel Render instances/restarts do not lose it.
  verifySignedOAuthState(state, email);
  // The database claim is an extra one-time-use guard when the token row is
  // present. The signed state is the primary validation and remains valid
  // across stateless app instances; Google's authorization code is itself
  // single-use, so a missing local row must not produce a false CSRF failure.
  await GoogleToken.findOneAndUpdate(
    { provider: "google", email, authState: state, authStateExpiresAt: { $gt: new Date() } },
    { $set: { authState: null, authStateExpiresAt: null } },
    { new: false }
  ).lean();
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(`${OAUTH_TOKEN_URL}?${body}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) {
    const err = new Error(`Google token exchange failed (${res.status})`);
    err.code = "GOOGLE_OAUTH_EXCHANGE_FAILED";
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  await saveToken({
    email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || undefined,
    scope: data.scope,
    expiresIn: data.expires_in,
  });
  await GoogleToken.updateOne({ provider: "google", email }, { $set: { authState: null, authStateExpiresAt: null } });
  return { ok: true };
}

export default { getAccessToken, saveToken, beginAuthorization, exchangeCode };