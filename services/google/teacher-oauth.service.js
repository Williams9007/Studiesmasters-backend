// services/google/teacher-oauth.service.js
//
// Google OAuth verification for teachers (Phase 6E - Enhanced).
//
// This service handles teacher Google account VERIFICATION ONLY.
// Unlike the admin Google OAuth (routes/googleRoutes.js), we do NOT store
// refresh tokens for teachers. We only verify their Google identity via
// the OAuth Sign-In flow with openid scope.
//
// Security features (enhanced):
//   - Uses google-auth-library for proper ID token verification
//   - Verifies token signature, issuer, audience, and email_verified
//   - CSRF protection via state nonce
//   - NO refresh tokens stored (per requirements)

import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import Teacher from "../../models/teacher.js";
import GoogleAccountAuditLog from "../../models/GoogleAccountAuditLog.js";
import { config } from "./config.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const TEACHER_SCOPES = ["openid", "email", "profile"].join(" ");

// Create OAuth2 client for token verification
const oauth2Client = new OAuth2Client(
  config.clientId,
  config.clientSecret,
  config.teacherRedirectUri
);

/**
 * Generate OAuth state nonce for CSRF protection.
 */
export function generateOAuthState() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Build the Google OAuth consent URL for teacher verification.
 */
export function buildTeacherConsentUrl(state, redirectUri) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: TEACHER_SCOPES,
    access_type: "online",
    state,
    prompt: "select_account",
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Verify a Google ID token using google-auth-library.
 * Provides proper cryptographic verification of:
 *   - Token signature
 *   - Issuer (accounts.google.com)
 *   - Audience (our client ID)
 *   - Email verification status
 */
export async function verifyGoogleIdToken(idToken, expectedEmail = null) {
  try {
    const ticket = await oauth2Client.verifyIdToken({
      idToken,
      audience: config.clientId,
    });

    const payload = ticket.getPayload();

    if (!payload) {
      throw new Error("Google ID token verification returned no payload");
    }

    // Verify issuer
    const validIssuers = ["accounts.google.com", "https://accounts.google.com"];
    if (!validIssuers.includes(payload.iss)) {
      throw new Error(`Invalid token issuer: ${payload.iss}`);
    }

    // Verify email is present
    if (!payload.email) {
      throw new Error("Google ID token missing email claim");
    }

    // Verify email is verified by Google
    if (!payload.email_verified) {
      throw new Error("Google email not verified");
    }

    // If we expect a specific email, validate it
    if (expectedEmail && payload.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(`Google email mismatch: expected ${expectedEmail}, got ${payload.email}`);
    }

    return {
      email: payload.email,
      emailVerified: payload.email_verified,
      googleId: payload.sub,
      name: payload.name || null,
      picture: payload.picture || null,
      verifiedEmail: payload.verified_email || false,
    };
  } catch (err) {
    if (err.message.includes("Invalid ID token") || err.message.includes("invalid_token")) {
      throw new Error("Invalid Google ID token");
    }
    if (err.message.includes("audience mismatch")) {
      throw new Error("Google token audience mismatch");
    }
    throw new Error(`Google ID token verification failed: ${err.message}`);
  }
}

/**
 * Exchange authorization code for tokens and verify identity.
 */
export async function exchangeAndVerifyCode(code, expectedEmail = null) {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text().catch(() => "");
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${errorText.slice(0, 200)}`);
  }

  const tokenData = await tokenRes.json();
  const idToken = tokenData.id_token;

  if (!idToken) {
    throw new Error("Google did not return an ID token");
  }

  return await verifyGoogleIdToken(idToken, expectedEmail);
}

/**
 * Initiate the teacher Google verification flow.
 * Creates a pending state and returns the consent URL.
 */
export async function initiateTeacherVerification(teacherId) {
  const teacher = await Teacher.findById(teacherId);
  if (!teacher) {
    throw new Error("Teacher not found");
  }

  if (!teacher.email) {
    throw new Error("Teacher has no email");
  }

  const state = generateOAuthState();

  await Teacher.findByIdAndUpdate(teacherId, {
    $set: {
      googleOAuthState: "pending",
      googleOAuthNonce: state,
      googleOAuthStateExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  const consentUrl = buildTeacherConsentUrl(state, config.teacherRedirectUri);

  return {
    state,
    consentUrl,
    teacherEmail: teacher.email,
    googleMeetEmail: teacher.googleMeetEmail,
  };
}

/**
 * Complete the teacher Google verification flow.
 * Called from the OAuth callback endpoint.
 */
export async function completeTeacherVerification(code, state, teacherId, reqInfo = {}) {
  const teacher = await Teacher.findById(teacherId);
  if (!teacher) {
    throw new Error("Teacher not found");
  }

  const verification = await exchangeAndVerifyCode(code, teacher.googleMeetEmail);

  const oldGoogleEmail = teacher.googleMeetEmail;
  const newGoogleEmail = verification.email;

  await Teacher.findByIdAndUpdate(teacherId, {
    $set: {
      googleMeetEmail: newGoogleEmail,
      googleAccountVerified: true,
      googleVerifiedAt: new Date(),
      googleOAuthState: "verified",
      googleOAuthNonce: null,
      googleOAuthStateExpiresAt: null,
    },
  });

  // Audit logging is best-effort and must not turn a verified connection into
  // a failed OAuth callback.
  try {
    await GoogleAccountAuditLog.logConnection({
      teacherId,
      googleEmail: newGoogleEmail,
      performedBy: teacherId,
      ipAddress: reqInfo.ipAddress || null,
      userAgent: reqInfo.userAgent || null,
      details: {
        oldEmail: oldGoogleEmail,
        method: "oauth_verification",
      },
      success: true,
    });
  } catch (auditError) {
    console.error("Teacher Google connection audit log failed:", auditError);
  }

  return {
    success: true,
    googleEmail: verification.email,
    googleId: verification.googleId,
    verifiedAt: new Date(),
  };
}

/**
 * Disconnect a teacher's Google account.
 */
export async function disconnectTeacherGoogle(teacherId, reqInfo = {}) {
  const teacher = await Teacher.findById(teacherId);
  if (!teacher) {
    throw new Error("Teacher not found");
  }

  const oldEmail = teacher.googleMeetEmail;

  await Teacher.findByIdAndUpdate(teacherId, {
    $set: {
      googleMeetEmail: null,
      googleAccountVerified: false,
      googleVerifiedAt: null,
      googleOAuthState: "not_connected",
      googleOAuthNonce: null,
      googleOAuthStateExpiresAt: null,
    },
  });

  // Log to audit trail
  await GoogleAccountAuditLog.create({
    teacherId,
    action: "google_disconnected",
    googleEmail: oldEmail,
    performedBy: teacherId,
    ipAddress: reqInfo.ipAddress || null,
    userAgent: reqInfo.userAgent || null,
    details: { method: "teacher_disconnect" },
    success: true,
  });

  return { success: true };
}

/**
 * Get teacher's Google verification status.
 */
export async function getTeacherGoogleStatus(teacherId) {
  const teacher = await Teacher.findById(teacherId).select(
    "googleMeetEmail googleAccountVerified googleVerifiedAt googleOAuthState"
  );

  if (!teacher) {
    return null;
  }

  return {
    connected: teacher.googleAccountVerified,
    googleMeetEmail: teacher.googleMeetEmail,
    verifiedAt: teacher.googleVerifiedAt,
    status: teacher.googleOAuthState,
  };
}

export default {
  generateOAuthState,
  buildTeacherConsentUrl,
  verifyGoogleIdToken,
  exchangeAndVerifyCode,
  initiateTeacherVerification,
  completeTeacherVerification,
  disconnectTeacherGoogle,
  getTeacherGoogleStatus,
};