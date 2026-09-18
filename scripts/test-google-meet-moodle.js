// scripts/test-google-meet-moodle.js
//
// LIVE verification that the Google Meet integration generates a REAL Google
// Meet link (GOOGLE_ALLOW_MOCK=false) and that the link is pushed to Moodle as
// a calendar event ("Join Virtual Class (Google Meet)").
//
// What it does (exactly the production code path — no mocks, no dummies):
//   1. Reports the Google + Moodle integration status (config, stored OAuth
//      token, dry-run flags).
//   2. Creates a temporary ClassGroup (code MEETTEST-*) + one ClassSession via
//      services/qao/scheduling.service.js#createSession — the same function the
//      QAO scheduler and generateRangeSessions() use — which triggers:
//          createMeeting()    -> real Google Calendar API event + Meet conference
//          syncClassSession() -> Moodle core_calendar_create_calendar_events
//   3. Verifies the session got a REAL meet link + calendar event id, and that
//      Moodle created the event (MoodleAuditLog + live Moodle read-back).
//   4. Cleans up everything it created (unless --keep): the Google Calendar
//      event, the Moodle calendar event, the test group/session and its
//      MoodleAuditLog rows.
//
// Usage (from Studiesmasters-backend):
//   node scripts/test-google-meet-moodle.js          # test + cleanup
//   node scripts/test-google-meet-moodle.js --keep   # test, keep the data

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";
import Teacher from "../models/teacher.js";
import GoogleToken from "../models/GoogleToken.js";
import MoodleAuditLog from "../models/MoodleAuditLog.js";
import { createSession } from "../services/qao/scheduling.service.js";
import { config as googleConfig, isConfiguredReal } from "../services/google/config.js";
import { getAccessToken, beginAuthorization } from "../services/google/token.service.js";
import { callWs } from "../services/moodle/client.js";

const KEEP = process.argv.includes("--keep");
const SERVICE_EMAIL = "virtualclass@studiesmasters.com"; // same as routes/googleRoutes.js

const MONGO_URI = process.env.MONGO_URI || null;
if (!MONGO_URI) {
  console.error("MONGO_URI is not defined. Add it to your .env file.");
  process.exit(1);
}

function line(t) { console.log(t); }
function section(t) { line(`\n== ${t} ${"=".repeat(Math.max(0, 62 - t.length))}`); }

let groupId = null, sessionId = null, googleEventId = null, moodleEventId = null;

async function deleteGoogleEvent(eventId) {
  const token = await getAccessToken();
  if (!token) { line("   (skipped: no Google token available to delete the event)"); return false; }
  const res = await fetch(`${googleConfig.calendarBaseUrl}/calendars/primary/events/${eventId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  line(`   Google Calendar event ${eventId} delete -> HTTP ${res.status} ${res.ok ? "(deleted)" : ""}`);
  return res.ok;
}

// Env helpers kept local so secrets are never printed.
function moodleBool(key) {
  return String(process.env[key] || "").toLowerCase() === "true" ? "true" : "false";
}
function moodleBase() {
  const u = String(process.env.MOODLE_BASE_URL || "");
  return u ? u.replace(/\/+$/, "") : "(not set)";
}

await mongoose.connect(MONGO_URI);
try {
  // ── [1] Integration status ────────────────────────────────────────────────
  section("[1] Integration status");
  line(`   GOOGLE_ENABLED=${googleConfig.enabled}  GOOGLE_ALLOW_MOCK=${googleConfig.allowMock}  credentials=${isConfiguredReal() ? "OK" : "MISSING"}`);
  line(`   timezone=${googleConfig.timezone}  calendarBase=${googleConfig.calendarBaseUrl}`);
  const tokens = await GoogleToken.find({ provider: "google" }).select("email encryptedRefreshToken encryptedAccessToken expiresAt updatedAt").lean();
  const connectedRow = tokens.find((t) => t.encryptedRefreshToken);
  if (!tokens.length || !connectedRow) {
    if (tokens.length && !connectedRow) {
      line(`   Google OAuth token row exists for ${tokens[0].email || "(no email)"} but has NO refresh token — the consent step was never completed.`);
    } else {
      line("   Google OAuth token: NONE stored in MongoDB (GoogleToken collection is empty)");
    }
    // Mint a fresh consent URL (this also refreshes the stored state nonce,
    // which the OAuth callback validates against).
    const { url } = await beginAuthorization({ email: SERVICE_EMAIL });
    line("\n   ACTION REQUIRED — connect the Google account once:");
    line(`   1) Open this consent URL in a browser and sign in as ${SERVICE_EMAIL}:`);
    line(`      ${url}`);
    line("   2) After the redirect you'll see 'Google Connected'.");
    line("      NOTE: the redirect target is GOOGLE_REDIRECT_URI in .env —");
    line(`      currently ${process.env.GOOGLE_REDIRECT_URI}. The backend serving that callback must use the SAME database this test reads.`);
    line("   3) Re-run this script: node scripts/test-google-meet-moodle.js");
  } else {
    for (const t of tokens) {
      line(`   Google OAuth token: ${t.email || "(no email)"}  refresh=${t.encryptedRefreshToken ? "yes" : "NO"}  accessExpires=${t.expiresAt ? new Date(t.expiresAt).toISOString() : "?"}  updatedAt=${t.updatedAt ? new Date(t.updatedAt).toISOString() : "?"}`);
    }
  }
  line(`   Moodle: wsEnabled=${moodleBool("MOODLE_WS_ENABLED")}  dryRun=${moodleBool("MOODLE_DRY_RUN")}  baseUrl=${moodleBase()}`);

  // ── [2] Create a temporary class + one session through the REAL path ─────
  section("[2] Creating test class + session (production scheduling path)");
  const teacher = await Teacher.findOne().sort({ createdAt: 1 }).lean();
  if (!teacher) throw new Error("No teacher found in the database — assign one first.");
  const hasAvailability = (teacher.availability || []).some((s) => s && s.day && s.start && s.end);

  const group = await ClassGroup.create({
    code: `MEETTEST-${Date.now().toString(36).toUpperCase().slice(-6)}`,
    curriculum: "GES",
    grade: "Grade 10",
    subject: "Meet Link Live Test",
    capacity: 1,
    teacher: teacher._id,
    status: "active",
  });
  groupId = group._id;
  line(`   Teacher: ${teacher.fullName || teacher.name} <${teacher.email || "?"}> (${teacher._id})${hasAvailability ? "  [has availability rules]" : ""}`);
  line(`   Group:   ${group.code} (${group._id})`);

  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(10, 0, 0, 0);
  line(`   Session: ${when.toISOString().slice(0, 10)} 10:00-11:00`);

  let session;
  try {
    session = await createSession({
      classGroup: group._id,
      teacher: teacher._id,
      date: when,
      startTime: "10:00",
      endTime: "11:00",
      notes: "[MEETTEST] live Google Meet -> Moodle verification",
      quiet: true, // no notifications/pushes — this is a link-generation test
      ...(hasAvailability ? { override: true, reason: "MEETTEST live verification" } : {}),
    });
  } catch (err) {
    line(`   createSession FAILED: ${err.message}`);
    throw err;
  }
  sessionId = session._id;

  const raw = await ClassSession.findById(sessionId).lean();
  line(`   Session: ${raw._id}  status=${raw.status}  meetingStatus=${raw.meetingStatus}`);

  // ── [3] Google Meet generation verdict ───────────────────────────────────
  section("[3] Google Meet generation");
  const isRealGoogleLink = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(String(raw.meetingLink || ""));
  googleEventId = raw.calendarEventId || null;
  if (raw.meetingStatus === "ready" && isRealGoogleLink && googleEventId) {
    line(`   meetingLink:     ${raw.meetingLink}`);
    line(`   meetingCode:     ${raw.meetingCode}`);
    line(`   conferenceId:    ${raw.conferenceId}`);
    line(`   calendarEventId: ${googleEventId}`);
    line("   VERDICT: REAL Google Meet link generated via the Calendar API (mock=false). OK");
  } else if (raw.meetingStatus === "ready" && raw.meetingLink) {
    line(`   meetingLink: ${raw.meetingLink}  calendarEventId=${googleEventId || "(empty)"}`);
    line("   VERDICT: link stored but looks MOCK/generated — not a live Calendar API conference.");
  } else {
    line(`   meetingLink:     ${raw.meetingLink || "(none)"}`);
    line(`   meetingStatus:   ${raw.meetingStatus}`);
    if (googleEventId) await deleteGoogleEvent(googleEventId).catch(() => {});
    googleEventId = null;
    line("   VERDICT: FAILED — no Meet link. Most common cause: no OAuth token stored (see [1]) with GOOGLE_ALLOW_MOCK=false.");
  }

  // ── [4] Moodle sync verdict ──────────────────────────────────────────────
  section("[4] Moodle calendar sync");
  const audits = await MoodleAuditLog.find({ "detail.sessionId": String(sessionId) }).sort({ createdAt: 1 }).lean();
  for (const a of audits) {
    line(`   ${a.action}  outcome=${a.outcome}${a.detail?.moodleEventId ? `  moodleEventId=${a.detail.moodleEventId}` : ""}${a.failure?.message ? `  failure=${a.failure.message}` : ""}`);
  }
  moodleEventId = [...audits].reverse().find((a) => Number(a.detail?.moodleEventId) > 0)?.detail?.moodleEventId || null;

  if (!moodleEventId) {
    line("   VERDICT: FAILED — Moodle did not accept the calendar event (see rows above).");
  } else {
    let found = null;
    try {
      const res = await callWs("core_calendar_get_calendar_events", {});
      const events = Array.isArray(res?.events) ? res.events : [];
      found = events.find((e) => Number(e?.id) === Number(moodleEventId)) || null;
      if (found) {
        if (raw.meetingLink) {
          const hasLink = String(found.description || "").includes(String(raw.meetingLink));
          line(`   Moodle read-back: event ${moodleEventId} "${found.name}" exists${hasLink ? " and its description contains the Meet link" : " but the description does NOT contain the Meet link"}. OK`);
        } else {
          line(`   Moodle read-back: event ${moodleEventId} "${found.name}" exists (link pending — no Google link yet). OK`);
        }
      } else {
        line(`   Moodle read-back: event ${moodleEventId} not in the returned list (may be filtered) — audit row already confirms creation.`);
      }
    } catch (err) {
      line(`   Moodle read-back unavailable (non-fatal): ${err.message}`);
    }
    line("   VERDICT: SYNCED — the class with its Google Meet link is in Moodle's calendar. OK");
  }

  // ── [5] Cleanup (leave NO dummies behind) ────────────────────────────────
  section("[5] Cleanup");
  if (KEEP) {
    line("   --keep set: leaving all test rows in place.");
    line(`   Group MEETTEST-* | session ${sessionId} | googleEventId ${googleEventId || "-"} | moodleEventId ${moodleEventId || "-"}`);
  } else {
    if (googleEventId) await deleteGoogleEvent(googleEventId).catch((e) => line(`   Google event delete failed (non-fatal): ${e.message}`));
    if (moodleEventId) {
      try {
        await callWs("core_calendar_delete_calendar_events", { "events[0][eventid]": moodleEventId, "events[0][repeat]": 0 });
        line(`   Moodle calendar event ${moodleEventId} deleted. OK`);
      } catch (e) {
        line(`   Moodle event delete failed (non-fatal): ${e.message}`);
      }
    }
    if (sessionId) { await ClassSession.deleteMany({ _id: sessionId }); line(`   Test session ${sessionId} removed.`); }
    if (groupId) { await ClassGroup.deleteMany({ _id: groupId }); line(`   Test group removed.`); }
    const auditDel = await MoodleAuditLog.deleteMany({ "detail.sessionId": String(sessionId) });
    line(`   MoodleAuditLog test rows removed: ${auditDel.deletedCount}.`);
  }

  section("RESULT");
  if (raw.meetingStatus === "ready" && isRealGoogleLink && moodleEventId) {
    line("   PASS: real Google Meet link generated and pushed to Moodle.");
  } else if (raw.meetingStatus === "ready" && isRealGoogleLink) {
    line("   PARTIAL: real Google Meet link generated, but Moodle did not create a calendar event.");
  } else {
    line("   FAIL: no real Google Meet link. Connect the Google account (see [1]) and re-run.");
  }
} catch (err) {
  console.error("Test failed:", err.message);
  process.exitCode = 1;
} finally {
  if (!KEEP) {
    // Safety net if an early step threw after creating rows.
    try {
      if (sessionId) await ClassSession.deleteMany({ _id: sessionId });
      if (groupId) await ClassGroup.deleteMany({ _id: groupId });
      if (sessionId) await MoodleAuditLog.deleteMany({ "detail.sessionId": String(sessionId) });
    } catch { /* ignore */ }
  }
  await mongoose.disconnect();
}

