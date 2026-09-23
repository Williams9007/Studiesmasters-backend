// services/google/calendar-attendee.service.js
//
// Calendar attendee management for Google Meet co-host workflow (Phase 6E Enhanced).
//
// This service handles:
//   - Adding teacher Google email as meeting attendee
//   - Verifying attendee creation
//   - Updating attendees when teacher is replaced
//   - Removing old teacher and adding new teacher

import { config } from "./config.js";
import { getAccessToken } from "./token.service.js";

const CALENDAR_BASE_URL = config.calendarBaseUrl || "https://www.googleapis.com/calendar/v3";

/**
 * Update calendar event attendees when teacher is replaced.
 * Removes old teacher and adds new teacher to the attendee list.
 */
export async function updateMeetingAttendees({
  calendarEventId,
  oldTeacherEmail = null,
  newTeacherEmail = null,
}) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("No Google access token available");
  }

  // Get the existing event
  const getRes = await fetch(
    `${CALENDAR_BASE_URL}/calendars/primary/events/${calendarEventId}`,
    {
      headers: { authorization: `Bearer ${token}` },
    }
  );

  if (!getRes.ok) {
    throw new Error(`Failed to get calendar event: ${getRes.status}`);
  }

  const event = await getRes.json();

  // Build new attendee list
  let attendees = event.attendees || [];

  // Remove old teacher if provided
  if (oldTeacherEmail) {
    attendees = attendees.filter(
      (a) => !(a.email && a.email.toLowerCase() === oldTeacherEmail.toLowerCase())
    );
  }

  // Add new teacher if provided and not already in list
  if (newTeacherEmail) {
    const alreadyExists = attendees.some(
      (a) => a.email && a.email.toLowerCase() === newTeacherEmail.toLowerCase()
    );
    if (!alreadyExists) {
      attendees.push({
        email: newTeacherEmail,
        responseStatus: "needsAction",
      });
    }
  }

  // Update the event with new attendee list
  const updateRes = await fetch(
    `${CALENDAR_BASE_URL}/calendars/primary/events/${calendarEventId}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attendees: attendees,
      }),
    }
  );

  if (!updateRes.ok) {
    throw new Error(`Failed to update calendar event attendees: ${updateRes.status}`);
  }

  return { success: true, attendees: attendees.length };
}

/**
 * Verify that a teacher email is in the attendee list.
 */
export async function verifyTeacherAttendee(calendarEventId, teacherEmail) {
  const token = await getAccessToken();
  if (!token) {
    return { verified: false, reason: "No access token" };
  }

  const getRes = await fetch(
    `${CALENDAR_BASE_URL}/calendars/primary/events/${calendarEventId}`,
    {
      headers: { authorization: `Bearer ${token}` },
    }
  );

  if (!getRes.ok) {
    return { verified: false, reason: "Cannot fetch event" };
  }

  const event = await getRes.json();
  const attendees = event.attendees || [];

  const found = attendees.some(
    (a) => a.email && a.email.toLowerCase() === teacherEmail.toLowerCase()
  );

  return {
    verified: found,
    teacherEmail,
    hasAttendees: attendees.length > 0,
  };
}

/**
 * Add teacher as attendee to an existing meeting.
 */
export async function addTeacherAsAttendee(calendarEventId, teacherEmail) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("No Google access token available");
  }

  // Check if already an attendee
  const existing = await verifyTeacherAttendee(calendarEventId, teacherEmail);
  if (existing.verified) {
    return { success: true, alreadyPresent: true };
  }

  // Get the existing event
  const getRes = await fetch(
    `${CALENDAR_BASE_URL}/calendars/primary/events/${calendarEventId}`,
    {
      headers: { authorization: `Bearer ${token}` },
    }
  );

  if (!getRes.ok) {
    throw new Error(`Failed to get calendar event: ${getRes.status}`);
  }

  const event = await getRes.json();

  // Add teacher to attendees
  const newAttendee = {
    email: teacherEmail,
    responseStatus: "needsAction",
  };

  const updateRes = await fetch(
    `${CALENDAR_BASE_URL}/calendars/primary/events/${calendarEventId}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attendees: [...(event.attendees || []), newAttendee],
      }),
    }
  );

  if (!updateRes.ok) {
    throw new Error(`Failed to add attendee: ${updateRes.status}`);
  }

  return { success: true, alreadyPresent: false };
}

export default {
  updateMeetingAttendees,
  verifyTeacherAttendee,
  addTeacherAsAttendee,
};