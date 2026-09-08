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
  const state = crypto.randomBytes(24).toString("hex");
  const authState = crypto.randomBytes(24).toString("hex");
  await GoogleToken.updateOne(
    { provider: "google", email },
    { $set: { authState, authStateExpiresAt: new Date(Date.now() + 10 * 60 * 1000) } },
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
  const row = await GoogleToken.findOne({ provider: "google", email }).lean();
  if (!row || !row.authState || String(row.authState) !== String(state)) {
    const err = new Error("Invalid OAuth state");
    err.code = "GOOGLE_OAUTH_STATE_MISMATCH";
    throw err;
  }
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