// services/moodle/suspendUser.js
//
// Suspend or reactivate a Moodle account. Suspension is reversible without
// losing identity or enrollments. Mirrors the authoritative state from MongoDB
// to Moodle; also used by the reconciliation/cleanup jobs.
import { client } from "./client.js";
import MoodleLink from "../../models/MoodleLink.js";
import { audit } from "./audit.js";

export async function suspendUser({ role, id, suspended = true, req = null }) {
  const link = await MoodleLink.findOne(role === "teacher" ? { teacherRef: id } : { studentRef: id });
  if (!link?.moodleUserId) {
    return { ok: true, skipped: true, reason: "not_provisioned" };
  }
  const action = suspended ? "SUSPENDED" : "REACTIVATED";
  try {
    await client.setSuspended(link.moodleUserId, suspended);
  } catch (err) {
    await audit({ action, outcome: "failure", failure: err.message,
      role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
      moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername, req, createdBy: "suspendUser" });
    throw err;
  }
  link.suspended = suspended;
  link.active = !suspended;
  await link.save();

  await audit({ action, outcome: "success",
    role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
    moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername, req, createdBy: "suspendUser" });
  return { ok: true, suspended, moodleUserId: link.moodleUserId };
}

export default suspendUser;