// services/moodle/unenrollUser.js
//
// Remove a user from Moodle courses that are no longer desired (subject removed,
// package downgraded, subscription expired). Idempotent. Also used by the
// reconciliation job to repair stale enrollments found in Moodle.
import { client } from "./client.js";
import MoodleLink from "../../models/MoodleLink.js";
import { audit } from "./audit.js";

export async function unenrollUser({ role, id, courseIds = [], req = null }) {
  const link = await MoodleLink.findOne(role === "teacher" ? { teacherRef: id } : { studentRef: id });
  if (!link?.moodleUserId) {
    return { ok: true, skipped: true, reason: "not_provisioned" };
  }
  const toRemove = courseIds.filter((c) => link.enrolledCourseIds.includes(c));
  if (!toRemove.length) return { ok: true, removed: [], alreadyRemoved: courseIds };

  const entries = toRemove.map((courseid) => ({ userid: link.moodleUserId, courseid }));
  try {
    await client.unenroll(entries);
  } catch (err) {
    await audit({ action: "ENROLLMENT_REMOVED", outcome: "failure", failure: err.message,
      role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
      moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername,
      detail: { requested: toRemove }, req, createdBy: "unenrollUser" });
    throw err;
  }

  link.enrolledCourseIds = link.enrolledCourseIds.filter((c) => !toRemove.includes(c));
  link.lastEnrollSyncAt = new Date();
  await link.save();

  await audit({ action: "ENROLLMENT_REMOVED", outcome: "success", detail: { removed: toRemove },
    role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
    moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername, req, createdBy: "unenrollUser" });

  return { ok: true, removed: toRemove, moodleUserId: link.moodleUserId };
}

export default unenrollUser;