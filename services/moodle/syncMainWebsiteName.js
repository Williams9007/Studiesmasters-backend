// services/moodle/syncMainWebsiteName.js
//
// Returns the real user name (fullName) for a given email from the StudiesMasters
// main website (MongoDB). Called by the Moodle SSO plugin during SSO login when
// the main website sync URL + token are configured.
//
// Only names are returned — passwords, roles and enrolments are never touched.
//
// Contract (for Moodle plugins):
//   GET /api/moodle/main-website/sync-name?email=...&token=...
//   POST /api/moodle/main-website/sync-name
//        Headers: Authorization: Bearer <token>
//                 X-StudiesMasters-Signature: HMAC_SHA256(JSON(users), token)
//        Body: { action: "lookup", users: ["email", ...] }
//   Responses: { success: true, fullName: "..." } for GET;
//   { success: true, action: "lookup", users: [{ email, fullName }] } for POST.

import Student from "../../models/Student.js";
import Teacher from "../../models/teacher.js";
import logger from "../../utils/logger.js";

/**
 * Look up the real fullName for an email in the main website (MongoDB).
 * Checks both Student and Teacher collections. Returns the name from whichever
 * collection the email belongs to. If the email is not found, returns null.
 */
export async function syncMainWebsiteName({ email, req = null } = {}) {
  const mail = String(email || "").trim().toLowerCase();
  if (!mail) return { fullName: null };

  // Check Students first, then Teachers. A user is in exactly one of these.
  let student = null;
  let teacher = null;
  try {
    const [s, t] = await Promise.all([
      Student.findOne({ email: mail }).select("fullName name").lean(),
      Teacher.findOne({ email: mail }).select("fullName name").lean(),
    ]);
    student = s;
    teacher = t;
  } catch (err) {
    logger.warn(`[MAIN-WEBSITE-SYNC] DB lookup failed for ${mail}: ${err?.message || err}`);
    return { fullName: null };
  }

  let fullName = null;
  if (student?.fullName) {
    fullName = student.fullName;
  } else if (student?.name) {
    fullName = student.name;
  } else if (teacher?.fullName) {
    fullName = teacher.fullName;
  } else if (teacher?.name) {
    fullName = teacher.name;
  }

  logger.info(`[MAIN-WEBSITE-SYNC] name for ${mail}: ${fullName || "(not found)"}`);
  return { fullName };
}

/** Resolve up to 200 unique emails in a bounded batch for Moodle Hub repair jobs. */
export async function syncMainWebsiteNames({ emails = [] } = {}) {
  const normalized = [...new Set((Array.isArray(emails) ? emails : [])
    .map((value) => String(value?.email || value || "").trim().toLowerCase())
    .filter(Boolean))].slice(0, 200);
  if (!normalized.length) return { users: [] };

  const [students, teachers] = await Promise.all([
    Student.find({ email: { $in: normalized } }).select("email fullName name").lean(),
    Teacher.find({ email: { $in: normalized } }).select("email fullName name").lean(),
  ]);
  const names = new Map();
  for (const record of [...students, ...teachers]) {
    const name = String(record.fullName || record.name || "").trim();
    if (name) names.set(String(record.email || "").trim().toLowerCase(), name);
  }
  return {
    users: normalized.map((email) => ({ email, fullName: names.get(email) || null })),
  };
}

export default { syncMainWebsiteName, syncMainWebsiteNames };
