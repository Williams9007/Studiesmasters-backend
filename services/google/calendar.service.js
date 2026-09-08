// services/google/calendar.service.js
//
// Thin wrapper around the Google Calendar API (v3). The real API path is used
// only when OAuth tokens are configured & available; otherwise it falls back to
// a deterministic mock payload so the full scheduling flow remains testable.
// Meeting creation is NEVER allowed to block class scheduling (see scheduling
// integration) — failures surface as meetingStatus="pending".
import crypto from "crypto";
import { config, isConfiguredReal } from "./config.js";
import { getAccessToken } from "./token.service.js";

// --- Mock helpers ----------------------------------------------------------
// Google Meet codes look like "abc-defg-hijk". We generate a deterministic but
// unique-looking code using uppercase letters + digits (Meet ignores case).
const CODE_CHARSET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/O/1/I/l ambiguity
const GROUP_LEN = [3, 4, 3];

function randGroup(len) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_CHARSET[crypto.randomInt(CODE_CHARSET.length)];
  return out;
}

export function generateMeetingCode() {
  return GROUP_LEN.map(randGroup).join("-");
}

export function makeMockPayload({ code = null } = {}) {
  const meetingCode = code || generateMeetingCode();
  // "mock" is a valid https meet URL so buttons work in dev without credentials.
  return {
    meetingLink: `https://meet.google.com/${meetingCode}`,
    meetingCode,
    conferenceId: `sm-mock-${meetingCode.replace(/-/g, "")}`,
    calendarEventId: null,
    mock: true,
  };
}

/**
 * Create a Google Calendar event with a Google Meet conference and return the
 * meeting details. Returns { meetingLink, meetingCode, conferenceId,
 * calendarEventId, mock }.
 *
 * Throws only when the integration is configured as real AND fails and mock is
 * not allowed — the scheduling layer catches this and marks the meeting pending.
 */
export async function createCalendarEvent({
  subject = "Class",
  description = "",
  timezone = null,
  startIso,
  endIso,
  attendees = [],
  sessionId = null,
}) {
  if (!config.enabled) {
    const err = new Error("Google integration disabled");
    err.code = "GOOGLE_DISABLED";
    throw err;
  }

  const tz = timezone || config.timezone || "UTC";

  // 1) If real credentials + a token are not usable, fall back to mock when allowed.
  const realReady = isConfiguredReal();
  const token = realReady ? await getAccessToken() : null;
  if (!realReady || !token) {
    if (config.allowMock) {
      const payload = makeMockPayload();
      payload.mock = true;
      return payload;
    }
    const err = new Error("Google not configured and mock disabled (GOOGLE_ALLOW_MOCK=false)");
    err.code = "GOOGLE_NOT_CONFIGURED";
    throw err;
  }

  // 2) Real Google Calendar v3 call.
  const eventBody = {
    summary: subject,
    description: description || subject,
    start: { dateTime: startIso, timeZone: tz },
    end: { dateTime: endIso, timeZone: tz },
    conferenceData: {
      createRequest: {
        requestId: `sm-${sessionId || crypto.randomBytes(8).toString("hex")}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
    attendees: attendees.map((email) => ({ email })),
    guestsCanModify: false,
  };

  let res;
  try {
    res = await fetch(`${config.calendarBaseUrl}/calendars/primary/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(eventBody),
    });
  } catch (err) {
    const e = new Error(`Google Calendar API network error: ${err.message}`);
    e.code = "GOOGLE_CALENDAR_NETWORK";
    throw e;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const e = new Error(`Google Calendar API error (${res.status}) ${detail.slice(0, 300)}`);
    e.code = "GOOGLE_CALENDAR_API";
    throw e;
  }

  const data = await res.json().catch(() => ({}));
  const entryPoint = (data.conferenceData?.entryPoints || [])
    .find((ep) => ep.entryPointType === "video") || (data.hangoutLink ? { uri: data.hangoutLink } : null);

  if (!entryPoint?.uri && config.allowMock) {
    return makeMockPayload({ code: generateMeetingCode() });
  }
  if (!entryPoint?.uri) {
    const e = new Error("Google returned no Meet link for the event");
    e.code = "GOOGLE_NO_MEET_LINK";
    throw e;
  }

  const uri = entryPoint.uri.replace(/\/$/, "");
  const meetingCode = uri.split("/").pop() || generateMeetingCode();
  return {
    meetingLink: uri,
    meetingCode,
    conferenceId: data.id || `gc-${meetingCode}`,
    calendarEventId: data.id || null,
    mock: false,
  };
}

export default { createCalendarEvent, generateMeetingCode, makeMockPayload };