// services/moodle/syncMainWebsiteName.js
//
// Returns the real user name (fullName) for a given email from the StudiesMasters
// main website (MongoDB). Called by the Moodle SSO plugin during SSO login when
// the main website sync URL + token are configured.
//
// Only names are returned — passwords, roles and enrolments are never touched.
//
// Contract (for the Moodle plugin):
//   GET /api/main-website/sync-name?email=...&token=...
//   Response: { success: true, fullName: "..." }  |  { success: false, reason: "..." }

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
      Teacher.findOne({ email: mail }).select("fullName").lean(),
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
  }

  logger.info(`[MAIN-WEBSITE-SYNC] name for ${mail}: ${fullName || "(not found)"}`);
  return { fullName };
}

export default syncMainWebsiteName;