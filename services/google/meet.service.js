// services/google/meet.service.js
//
// Highest-level Google Meet creation facade used by the scheduling service.
//
//   createMeeting({ ... })
//     -> { meetingProvider, meetingLink, meetingCode, conferenceId,
//          calendarEventId, meetingStatus, mock }
//
// It NEVER throws for the purpose of blocking a class session: any failure is
// converted into a "pending" meeting so the session is still created/saved and
// can be regenerated later. A throw here would only indicate a programming
// error.
import { config } from "./config.js";
import { createCalendarEvent } from "./calendar.service.js";

/**
 * Combine a date (Date | ISO string) with an "HH:MM" wall-clock time into an
 * ISO-8601 datetime string.
 */
export function combineDateTime(date, time) {
  const [h, m] = String(time).split(":").map((n) => Number(n));
  const d = new Date(date);
  if (![h, m].every(Number.isFinite)) throw new Error(`Invalid time value: ${time}`);
  d.setHours(h, m, 0, 0);
  return d.toISOString ? d.toISOString() : new Date(d).toISOString();
}

/**
 * Create (or mock) a Google Meet for a scheduled class.
 * Returns the meeting payload plus a meetingStatus of "ready" or "pending".
 */
export async function createMeeting({
  subject = "Class",
  grade = "",
  teacherName = "",
  teacherEmail = null,
  date = null,
  startTime,
  endTime,
  timezone = null,
  sessionId = null,
  rollNumber = null, // short ref used for description/labels
}) {
  const base = {
    meetingProvider: "google-meet",
    meetingLink: "",
    meetingCode: "",
    conferenceId: "",
    calendarEventId: "",
    meetingStatus: "pending",
    mock: true,
  };

  if (!config.enabled) return { ...base, note: "Google integration disabled" };

  try {
    const startIso = combineDateTime(date, startTime);
    const endIso = combineDateTime(date, endTime);
    const summary = `${subject}${grade ? ` - ${grade}` : ""}${teacherName ? ` (${teacherName})` : ""}`;
    const description = [
      `StudiesMasters virtual class`,
      `Subject: ${subject}`,
      grade ? `Grade: ${grade}` : "",
      teacherName ? `Teacher: ${teacherName}` : "",
      sessionId ? `Session: ${sessionId}` : "",
      rollNumber ? `Ref: ${rollNumber}` : "",
    ].filter(Boolean).join("\n");

    const data = await createCalendarEvent({
      subject: summary,
      description,
      timezone,
      startIso,
      endIso,
      attendees: teacherEmail ? [teacherEmail] : [],
      sessionId,
    });

    return {
      ...base,
      meetingLink: data.meetingLink || "",
      meetingCode: data.meetingCode || "",
      conferenceId: data.conferenceId || "",
      calendarEventId: data.calendarEventId || "",
      meetingStatus: data.meetingLink ? "ready" : "pending",
      mock: data.mock === true,
    };
  } catch (err) {
    // Deliberately swallow: mark pending so scheduling never breaks.
    return { ...base, meetingLink: "", meetingStatus: "pending", note: err.message };
  }
}

// ---------------------------------------------------------------------------
// Co-host promotion via Google Meet API v2 (fixes waiting-room issue)
// ---------------------------------------------------------------------------
// Being a Calendar attendee only INVITES the teacher — Google Meet does not
// promote attendees to co-host, so teachers landed in the waiting room with no
// controls. The Meet API members endpoint adds them as role=COHOST, which also
// lets them join WITHOUT knocking ("members can join without knocking").
// Scope required: https://www.googleapis.com/auth/meetings.space.created
// (the company account created the space, so it owns member management).

const MEET_API_BASE = "https://meet.googleapis.com/v2";

/**
 * Resolve the Meet API space name for a Calendar-created meeting.
 * Calendar gives us conferenceId (numeric) and meetingCode (abc-defg-hij);
 * the Meet API space name is spaces/{name}. We probe both candidates.
 */
async function resolveSpaceName(token, { conferenceId, meetingCode }) {
  const candidates = [];
  if (conferenceId) candidates.push(`spaces/${conferenceId}`);
  if (meetingCode) candidates.push(`spaces/${meetingCode.replace(/-/g, "")}`);
  if (meetingCode) candidates.push(`spaces/${meetingCode}`);

  for (const name of candidates) {
    try {
      const res = await fetch(`${MEET_API_BASE}/${name}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) return name;
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Promote the teacher's verified Google account to COHOST on the meeting.
 * Never throws — scheduling and join flows must not break if the Meet API
 * call fails (quota, license, space not yet created, etc.).
 *
 * @returns {{ promoted: boolean, space: string|null, reason?: string }}
 */
export async function promoteTeacherToCohost({ conferenceId, meetingCode, teacherEmail }) {
  if (!teacherEmail) return { promoted: false, space: null, reason: "no_teacher_email" };

  try {
    const tokenMod = await import("./token.service.js");
    const ownerEmail =
      process.env.GOOGLE_MEET_OWNER_EMAIL || "virtualclass@studiesmasters.com";
    const token = await tokenMod.getAccessToken({ email: ownerEmail });

    const space = await resolveSpaceName(token, { conferenceId, meetingCode });
    if (!space) return { promoted: false, space: null, reason: "space_not_found" };

    const res = await fetch(`${MEET_API_BASE}/${space}/members`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: teacherEmail, role: "COHOST" }),
    });

    if (res.ok) return { promoted: true, space };

    const body = await res.json().catch(() => ({}));
    // 409 = already a member (possibly already co-host) → treat as success.
    if (res.status === 409) return { promoted: true, space, reason: "already_member" };
    return {
      promoted: false,
      space,
      reason: `meet_api_${res.status}: ${body?.error?.message || "unknown"}`,
    };
  } catch (err) {
    return { promoted: false, space: null, reason: err.message };
  }
}

/**
 * Remove a replaced teacher from the meeting space so only the current
 * teacher holds co-host rights. Best-effort; never throws.
 */
export async function removeMemberFromMeeting({ conferenceId, meetingCode, email }) {
  if (!email) return { removed: false, reason: "no_email" };
  try {
    const tokenMod = await import("./token.service.js");
    const token = await tokenMod.getAccessToken({ email: process.env.GOOGLE_MEET_OWNER_EMAIL || "virtualclass@studiesmasters.com" });
    const space = await resolveSpaceName(token, { conferenceId, meetingCode });
    if (!space) return { removed: false, reason: "space_not_found" };

    const res = await fetch(
      `${MEET_API_BASE}/${space}/members/${encodeURIComponent(email)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } }
    );
    if (res.ok || res.status === 404) return { removed: res.ok, space };
    return { removed: false, space, reason: `meet_api_${res.status}` };
  } catch (err) {
    return { removed: false, reason: err.message };
  }
}

export default { createMeeting, combineDateTime, promoteTeacherToCohost, removeMemberFromMeeting };