// routes/googleRoutes.js
//
// Google OAuth 2.0 connection flow for the StudiesMasters Virtual Classroom.
//
// Flow:
//   1. Admin opens GET /api/google/oauth/start
//      → backend returns a Google consent URL (offline access + refresh token)
//   2. Admin logs in as virtualclass@studiesmasters.com and approves
//      → Google redirects to GET /api/google/oauth/callback?code=xxx
//      → backend exchanges code for tokens, encrypts refresh token, stores in MongoDB
//   3. GET /api/google/oauth/status → connection state
//   4. POST /api/google/oauth/test → verify real Calendar API access
//
// Security:
//   - Refresh tokens are AES-256-GCM encrypted before MongoDB storage
//   - State nonce prevents CSRF on the callback
//   - Secrets are never logged or returned to the client
//   - All connection events are written to AuditLog
import { Router } from "express";
import { adminAuth } from "../middleware/adminAuth.js";
import { logQaoAction } from "../services/qao/audit.service.js";
import GoogleToken from "../models/GoogleToken.js";
import { config, assertConfiguredReal } from "../services/google/config.js";
import { beginAuthorization, exchangeCode, getAccessToken } from "../services/google/token.service.js";

const router = Router();

const SERVICE_EMAIL = "virtualclass@studiesmasters.com";

/**
 * GET /api/google/oauth/start
 * Returns the Google OAuth consent URL. Admin must open this in a browser
 * and authorize with the virtualclass@studiesmasters.com account.
 */
router.get("/start", adminAuth, async (req, res) => {
  try {
    assertConfiguredReal();
    const { url } = await beginAuthorization({ email: SERVICE_EMAIL });
    res.json({
      success: true,
      consentUrl: url,
      serviceAccount: SERVICE_EMAIL,
      instructions: "Open this URL in a browser and authorize with virtualclass@studiesmasters.com. Google will redirect back to the callback URL.",
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/google/oauth/callback?code=xxx&state=xxx
 * Google redirects here after admin authorizes. Exchanges the code for tokens,
 * encrypts the refresh token, and stores it in MongoDB.
 */
router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send("Missing code or state parameter");
    }
    assertConfiguredReal();
    await exchangeCode({ code, state, email: SERVICE_EMAIL });

    await logQaoAction({
      action: "GOOGLE_CONNECTED",
      resource: "GoogleOAuth",
      resourceId: SERVICE_EMAIL,
      details: { email: SERVICE_EMAIL, by: req.admin?.id || "oauth-callback" },
    });

    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Google Connected</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4}
      .card{background:#fff;border:1px solid #bbf7d0;border-radius:16px;padding:32px;text-align:center;max-width:420px;box-shadow:0 10px 30px rgba(0,0,0,.06)}
      h1{color:#16a34a;font-size:20px;margin:0 0 8px}p{color:#475569;font-size:14px;margin:0}</style></head>
      <body><div class="card"><h1>Google Connected</h1><p>virtualclass@studiesmasters.com is now authorized. You can close this window and return to StudiesMasters.</p></div></body></html>`);
  } catch (err) {
    res.status(400).send(`<!doctype html><html><head><meta charset="utf-8"><title>Connection Failed</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fef2f2}
      .card{background:#fff;border:1px solid #fecaca;border-radius:16px;padding:32px;text-align:center;max-width:420px}
      h1{color:#dc2626;font-size:20px;margin:0 0 8px}p{color:#475569;font-size:14px;margin:0}</style></head>
      <body><div class="card"><h1>Connection Failed</h1><p>${(err.message || "Unknown error").replace(/</g, "&lt;")}</p></div></body></html>`);
  }
});
/**
 * GET /api/google/oauth/status
 * Returns whether the Google account is connected and authorized.
 */
router.get("/status", adminAuth, async (req, res) => {
  try {
    const row = await GoogleToken.findOne({ provider: "google", email: SERVICE_EMAIL }).lean();
    if (!row || !row.encryptedRefreshToken) {
      return res.json({ success: true, connected: false });
    }
    res.json({
      success: true,
      connected: true,
      account: SERVICE_EMAIL,
      scopes: row.scope ? row.scope.split(" ") : [],
      expiresAt: row.expiresAt || null,
      hasRefreshToken: true,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/google/oauth/test
 * Verifies real Google Calendar API access by creating and deleting a test event.
 */
router.post("/test", adminAuth, async (req, res) => {
  try {
    assertConfiguredReal();
    const token = await getAccessToken({ email: SERVICE_EMAIL });
    if (!token) {
      return res.json({ success: false, googleConnected: false, message: "No valid OAuth token. Run /api/google/oauth/start first." });
    }

    const now = new Date();
    const eventBody = {
      summary: "StudiesMasters OAuth Test",
      description: "Test event created by StudiesMasters to verify Google Calendar access.",
      start: { dateTime: new Date(now.getTime() + 60000).toISOString(), timeZone: config.timezone },
      end: { dateTime: new Date(now.getTime() + 120000).toISOString(), timeZone: config.timezone },
    };

    const createRes = await fetch(`${config.calendarBaseUrl}/calendars/primary/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(eventBody),
    });

    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => "");
      return res.json({ success: false, googleConnected: true, calendarAccess: false, message: `Calendar create failed (${createRes.status}): ${detail.slice(0, 200)}` });
    }

    const event = await createRes.json().catch(() => ({}));

    if (event.id) {
      await fetch(`${config.calendarBaseUrl}/calendars/primary/events/${event.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => {});
    }

    await logQaoAction({
      action: "GOOGLE_TOKEN_REFRESHED",
      resource: "GoogleOAuth",
      resourceId: SERVICE_EMAIL,
      details: { test: true, eventId: event.id || null, by: req.admin?.id || null },
    });

    res.json({ success: true, googleConnected: true, calendarAccess: true, message: "Google Calendar access verified. Meet links will now generate automatically." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;