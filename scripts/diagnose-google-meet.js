// scripts/diagnose-google-meet.js
//
// READ-ONLY diagnostic answering: "why is Google Meet not generating links?"
//
// It reports, without writing anything to the DB:
//   [1] Google config state (enabled / allowMock / credentials / scopes)
//   [2] GoogleToken rows: is the company account still connected? decryptable?
//   [3] A real token refresh attempt, capturing Google's exact error
//       (invalid_grant => revoked / expired consent, etc.)
//   [4] A read-only Calendar API call to prove the token actually works
//   [5] Recent ClassSession meetingStatus distribution (the symptom)
//
// With --probe it ALSO does a full end-to-end proof: creates one real Calendar
// event with conferenceData (the exact production call), reports whether Google
// returned a Meet entryPoint, then DELETES the event again.
//
// Run (from Studiesmasters-backend):
//   node scripts/diagnose-google-meet.js
//   node scripts/diagnose-google-meet.js --probe
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import GoogleToken from "../models/GoogleToken.js";
import ClassSession from "../models/ClassSession.js";
import { config, isConfiguredReal } from "../services/google/config.js";
import { decryptValue } from "../services/google/encryption.js";
import { getAccessToken } from "../services/google/token.service.js";

const PROBE = process.argv.includes("--probe");
const SERVICE_EMAIL = "virtualclass@studiesmasters.com";
const line = (s = "") => console.log(s);
const head = (s) => line(`\n=== ${s} ===`);

if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not defined.");
  process.exit(1);
}
await mongoose.connect(process.env.MONGO_URI);
line("Connected to MongoDB.");

// ------------------------------------------------------------------ [1] config
head("[1] Google config");
line(`  GOOGLE_ENABLED ....... ${config.enabled}`);
line(`  GOOGLE_ALLOW_MOCK .... ${config.allowMock}  ${config.allowMock ? "" : "(failures => NO link at all)"}`);
line(`  credentials .......... ${isConfiguredReal() ? "OK" : "MISSING"}`);
line(`  clientId ............. ${config.clientId ? `${config.clientId.slice(0, 12)}...` : "(unset)"}`);
line(`  tokenEncKey .......... ${config.tokenEncKey.length ? `set (${config.tokenEncKey.length} chars)` : "(unset)"}`);
line(`  scopes ............... ${config.scopes || "(empty!)"}`);
line(`  calendarBaseUrl ...... ${config.calendarBaseUrl}`);
if (!config.scopes.includes("calendar.events")) {
  line("  !! calendar.events scope MISSING -> Google will reject event creation");
}
if (!config.enabled) line("  !! GOOGLE_ENABLED=false -> createMeeting() bails immediately");

// ------------------------------------------------------------------ [2] tokens
head("[2] GoogleToken rows");
const rows = await GoogleToken.find({ provider: "google" })
  .select("email encryptedAccessToken encryptedRefreshToken scope expiresAt updatedAt createdAt")
  .sort({ updatedAt: -1 })
  .lean();
if (!rows.length) line("  NO GoogleToken rows at all -> nobody ever connected the account");
for (const r of rows) {
  const at = r.encryptedAccessToken ? decryptValue(r.encryptedAccessToken) : null;
  const rt = r.encryptedRefreshToken ? decryptValue(r.encryptedRefreshToken) : null;
  line(`  email ............... ${r.email ?? "(null - legacy row)"}`);
  line(`    access token ...... ${r.encryptedAccessToken ? (at ? "present, decrypts OK" : "present, DECRYPT FAILED (wrong GOOGLE_TOKEN_ENC_KEY?)") : "none"}`);
  line(`    refresh token ..... ${r.encryptedRefreshToken ? (rt ? "present, decrypts OK" : "present, DECRYPT FAILED (wrong GOOGLE_TOKEN_ENC_KEY?)") : "NONE -> cannot mint tokens, real links impossible"}`);
  line(`    expiresAt ......... ${r.expiresAt ? new Date(r.expiresAt).toISOString() : "(none)"}`);
  line(`    updatedAt ......... ${r.updatedAt ? new Date(r.updatedAt).toISOString() : "?"}`);
  line(`    stored scope ...... ${r.scope || "(empty)"}`);
}

// -------------------------------------------------------- [3] refresh attempt
head("[3] Live token acquisition");
const svcRow = await GoogleToken.findOne({ provider: "google", email: SERVICE_EMAIL }).lean();
let token = await getAccessToken({ email: SERVICE_EMAIL });
line(`  getAccessToken(${SERVICE_EMAIL}) -> ${token ? "OK" : "NULL"}`);

if (!token && svcRow?.encryptedRefreshToken) {
  const refreshToken = decryptValue(svcRow.encryptedRefreshToken);
  if (!refreshToken) {
    line("  refresh token does not decrypt -> WRONG GOOGLE_TOKEN_ENC_KEY (was it rotated?)");
  } else {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(`https://oauth2.googleapis.com/token?${body}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const data = await res.json().catch(() => ({}));
    line(`  manual refresh -> HTTP ${res.status}`);
    if (res.ok && data.access_token) {
      line("  refresh WORKS here -> token service logic is the problem");
      token = data.access_token;
    } else {
      line(`  Google error ....... ${data.error || "(none)"} ${data.error_description || ""}`);
      if (data.error === "invalid_grant") {
        line("  => refresh token REVOKED or EXPIRED (consent screen in 'Testing' mode");
        line("     expires grants after 7 days; password change / admin revocation also");
        line("     kills it). FIX: reconnect via /api/google/oauth/start.");
      }
    }
  }
} else if (!svcRow) {
  line(`  no GoogleToken row for ${SERVICE_EMAIL} -> account never connected (or disconnected)`);
}

// ------------------------------------------------------- [4] read-only API call
if (token) {
  head("[4] Read-only Calendar API check");
  const res = await fetch(`${config.calendarBaseUrl}/calendars/primary/events?maxResults=1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  line(`  GET calendars/primary/events -> HTTP ${res.status}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    line(`  detail: ${detail.slice(0, 300)}`);
    if (res.status === 401) line("  => token rejected (revoked / wrong account / clock?)");
    if (res.status === 403) line("  => scope or Google Calendar API enablement problem");
  } else {
    line("  token + scope are GOOD -> creation path should work");
  }
}

// ----------------------------------------------------------------- [5] symptom
head("[5] Recent ClassSession meeting state");
const stats = await ClassSession.aggregate([
  { $group: { _id: "$meetingStatus", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
]);
for (const s of stats) line(`  ${(s._id ?? "(missing)").padEnd(8)} ${s.count}`);
const recent = await ClassSession.find({})
  .select("date startTime endTime meetingStatus meetingLink meetingCode createdAt")
  .sort({ createdAt: -1 })
  .limit(8)
  .lean();
for (const s of recent) {
  const d = s.date instanceof Date ? s.date.toISOString().slice(0, 10) : "?";
  line(`  ${new Date(s.createdAt).toISOString().slice(0, 16)}  status=${s.meetingStatus}  link=${s.meetingLink || "(none)"}  ${d} ${s.startTime}`);
}

// ------------------------------------------------------------------- [6] probe
if (PROBE) {
  head("[6] End-to-end probe (create real event + Meet, then DELETE it)");
  const tok = token || (await getAccessToken({ email: SERVICE_EMAIL }));
  if (!tok) {
    line("  skipped: no access token available");
  } else {
    const body = {
      summary: "StudiesMasters meet-link probe (auto-deleted)",
      description: "Diagnostic probe created by scripts/diagnose-google-meet.js",
      start: { dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(), timeZone: config.timezone },
      end: { dateTime: new Date(Date.now() + 90 * 60 * 1000).toISOString(), timeZone: config.timezone },
      conferenceData: {
        createRequest: {
          requestId: `probe-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    };
    const res = await fetch(`${config.calendarBaseUrl}/calendars/primary/events?conferenceDataVersion=1`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    line(`  POST event+conferenceData -> HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      line(`  error: ${JSON.stringify(data).slice(0, 400)}`);
    } else {
      const ep = (data.conferenceData?.entryPoints || []).find((e) => e.entryPointType === "video");
      line(`  meet entryPoint ..... ${ep?.uri || "(NONE - Google created a plain event)"}`);
      line(`  hangoutLink ......... ${data.hangoutLink || "(none)"}`);
      if (data.id) {
        const del = await fetch(`${config.calendarBaseUrl}/calendars/primary/events/${data.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${tok}` },
        });
        line(`  cleanup DELETE -> HTTP ${del.status}`);
      }
    }
  }
}

await mongoose.disconnect();
line("\nDone (nothing was written to the database).");


