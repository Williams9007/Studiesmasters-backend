// routes/googleTeacherRoutes.js
//
// Google OAuth verification endpoints for teachers (Phase 6E).
//
// These endpoints allow teachers to connect and verify their personal
// Google accounts for Meet co-host access. Unlike the admin Google OAuth
// (routes/googleRoutes.js), we do NOT store refresh tokens - only verify
// identity via Google Sign-In.
//
// Flow:
//   1. GET /api/google/teacher/connect - Returns OAuth consent URL
//   2. GET /api/google/teacher/callback - Google redirects here
//   3. GET /api/google/teacher/status - Check verification status
//   4. POST /api/google/teacher/disconnect - Remove Google connection

import { Router } from "express";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import Teacher from "../models/teacher.js";
import {
  initiateTeacherVerification,
  completeTeacherVerification,
  disconnectTeacherGoogle,
  getTeacherGoogleStatus,
} from "../services/google/teacher-oauth.service.js";

const router = Router();

/**
 * GET /api/google/teacher/connect
 * Initiate Google account verification for the authenticated teacher.
 */
router.get("/connect", verifyTeacher, async (req, res) => {
  try {
    const teacherId = req.user._id;

    // Check if already verified
    if (req.user.googleAccountVerified) {
      return res.json({
        success: true,
        alreadyConnected: true,
        googleMeetEmail: req.user.googleMeetEmail,
        message: "Google account already connected",
      });
    }

    // Initiate verification flow
    const result = await initiateTeacherVerification(teacherId);

    res.json({
      success: true,
      consentUrl: result.consentUrl,
      state: result.state,
      instructions: "Sign in with the Google account you want to use for Meet co-host access.",
    });
  } catch (err) {
    console.error("Teacher Google connect error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to initiate Google connection",
    });
  }
});
/**
 * GET /api/google/teacher/callback
 * Google OAuth callback - called after teacher signs in.
 * Exchanges authorization code for identity verification.
 *
 * NOTE: This endpoint is public (no JWT) because Google redirects here.
 * We resolve the teacher from the short-lived state nonce stored server-side.
 */
router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Connection Failed</title></head>
        <body style="font-family: system-ui; padding: 20px;">
          <div style="border: 1px solid #fecaca; background: #fef2f2; padding: 20px; border-radius: 8px; max-width: 400px;">
            <h2 style="color: #dc2626; margin-top: 0;">Connection Failed</h2>
            <p>Missing required parameters. Please try again.</p>
            <a href="/" style="color: #2563eb;">Return to StudiesMasters</a>
          </div>
        </body>
        </html>
      `);
    }

    const teacher = await Teacher.findOne({
      googleOAuthNonce: state,
      googleOAuthState: "pending",
      googleOAuthStateExpiresAt: { $gt: new Date() },
    }).select("_id");

    if (!teacher) {
      throw new Error("This Google connection request is invalid or has expired. Please start again.");
    }

    // Complete verification (pass request info for audit logging)
    const result = await completeTeacherVerification(code, state, teacher._id, {
      ipAddress: req.ip || req.connection?.remoteAddress || null,
      userAgent: req.headers?.["user-agent"] || null,
    });

    // Send success page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Google Account Connected</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; background: #f0fdf4; margin: 0; padding: 20px; }
          .card { background: white; border: 1px solid #bbf7d0; border-radius: 12px; padding: 32px; max-width: 420px; margin: 0 auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          h1 { color: #16a34a; font-size: 20px; margin: 0 0 8px; }
          p { color: #475569; font-size: 14px; margin: 0 0 16px; }
          .email { font-family: monospace; background: #f8fafc; padding: 8px 12px; border-radius: 6px; word-break: break-all; }
          .btn { display: inline-block; background: #2563eb; color: white; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Google Account Connected</h1>
          <p>Your Google account has been verified and linked to your StudiesMasters teacher account.</p>
          <p><strong>Google Email:</strong><br><span class="email">${result.googleEmail}</span></p>
          <p style="font-size: 12px; color: #94a3b8;">You can now close this window and return to your dashboard.</p>
          <p style="margin-top: 24px;"><a href="${process.env.FRONTEND_URL || "https://studiesmasters.com"}/dashboard" class="btn">Return to Dashboard</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Teacher Google callback error:", err);

    // Send error page
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Connection Failed</title></head>
      <body style="font-family: system-ui; padding: 20px;">
        <div style="border: 1px solid #fecaca; background: #fef2f2; padding: 20px; border-radius: 8px; max-width: 400px;">
          <h2 style="color: #dc2626; margin-top: 0;">Connection Failed</h2>
          <p>${err.message || "An error occurred during Google account verification."}</p>
          <p style="font-size: 12px; color: #94a3b8; margin-top: 16px;">Please try again or contact support if the problem persists.</p>
          <a href="${process.env.FRONTEND_URL || "https://studiesmasters.com"}/dashboard" style="color: #2563eb; display: inline-block; margin-top: 16px;">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  }
});
/**
 * GET /api/google/teacher/status
 * Get the current Google verification status for the authenticated teacher.
 */
router.get("/status", verifyTeacher, async (req, res) => {
  try {
    const status = await getTeacherGoogleStatus(req.user._id);

    res.json({
      success: true,
      data: status,
    });
  } catch (err) {
    console.error("Teacher Google status error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to get Google status",
    });
  }
});

/**
 * POST /api/google/teacher/disconnect
 * Disconnect the teacher's Google account.
 * This removes the verified Google email association.
 */
router.post("/disconnect", verifyTeacher, async (req, res) => {
  try {
    // Check if connected
    if (!req.user.googleAccountVerified) {
      return res.status(400).json({
        success: false,
        message: "No Google account connected",
      });
    }

    await disconnectTeacherGoogle(req.user._id, {
      ipAddress: req.ip || req.connection?.remoteAddress || null,
      userAgent: req.headers?.["user-agent"] || null,
    });

    res.json({
      success: true,
      message: "Google account disconnected successfully",
    });
  } catch (err) {
    console.error("Teacher Google disconnect error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to disconnect Google account",
    });
  }
});

export default router;