// services/google/index.js
//
// Facade over the Google Meet integration so routes/controllers import one
// module (mirrors services/moodle/index.js).
import { config, isConfiguredReal } from "./config.js";
import { createMeeting, combineDateTime } from "./meet.service.js";
import { createCalendarEvent, generateMeetingCode, makeMockPayload } from "./calendar.service.js";
import { getAccessToken, saveToken, beginAuthorization, exchangeCode } from "./token.service.js";
import * as drive from "./drive.service.js";

export const google = {
  config,
  isConfiguredReal,
  createMeeting,
  combineDateTime,
  createCalendarEvent,
  generateMeetingCode,
  makeMockPayload,
  getAccessToken,
  saveToken,
  beginAuthorization,
  exchangeCode,
  drive,
};

export {
  config, isConfiguredReal, createMeeting, combineDateTime,
  createCalendarEvent, generateMeetingCode, makeMockPayload,
  getAccessToken, saveToken, beginAuthorization, exchangeCode,
  drive,
};

export default google;