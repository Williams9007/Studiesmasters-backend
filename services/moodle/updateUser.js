// services/moodle/updateUser.js
//
// Push profile changes for an existing Moodle user. Email, names and the
// lifecycle flag are backgrounded as a durable SyncJob when the backend's
// authoritative data changes. Relies on the stable MoodleUsername (never the
// email) to locate the account, so email edits are identity-safe.

import { client } from "./client.js";
import MoodleLink from "../../models/MoodleLink.js";
import { audit } from "./audit.js";

export async function updateUser({ role, id, email = null, fullName = null, userId = null, req = null }) {
  const link = await MoodleLink.findOne(
    role === "teacher" ? { teacherRef: id } : { studentRef: id }
  );
  if (!link?.moodleUserId) {
    // User isn't provisioned in Moodle yet; nothing to update.
    return { ok: true, skipped: true, reason: "not_provisioned" };
  }

  const fields = {};
  if (email != null && email !== link.email) fields.email = email;
  if (fullName) {
    const parts = String(fullName).trim().split(/\s+/);
    fields.firstname = parts.shift() || "";
    fields.lastname = parts.join(" ") || fields.firstname;
  }
  if (!Object.keys(fields).length) return { ok: true, skipped: true, reason: "no_changes" };

  try {
    await client.updateUser(link.moodleUserId, fields);
  } catch (err) {
    await audit({ action: "PROFILE_UPDATED", outcome: "failure", failure: err.message,
      role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
      moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername, req, createdBy: "updateUser" });
    throw err;
  }

  if (email != null) link.email = email;
  link.lastSyncedProfileAt = new Date();
  await link.save();

  await audit({ action: "PROFILE_UPDATED", outcome: "success", detail: { fields },
    role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
    moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername, req, createdBy: "updateUser" });

  return { ok: true, moodleUserId: link.moodleUserId };
}

export default updateUser;