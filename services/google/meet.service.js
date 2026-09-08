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

export default { createMeeting, combineDateTime };