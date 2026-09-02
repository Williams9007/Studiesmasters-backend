// services/moodle/enrollUser.js
//
// Enroll a provisioned Moodle user into the Moodle courses computed by the
// course mapper. Idempotent: courses already in the link's enrolledCourseIds
// are skipped and reported. On success the link's enrollment cache is updated.
// Also exposed as the body of a durable SyncJob (enrollment sync).

import { client } from "./client.js";
import MoodleLink from "../../models/MoodleLink.js";
import { getCourseIdsFor } from "./courseMapper.js";
import { audit } from "./audit.js";
import { config } from "./config.js";

export async function enrollUser({ role, id, subjects = [], curriculum = null, packageName = null, grade = null, courseIds = null, req = null }) {
  const link = await MoodleLink.findOne(role === "teacher" ? { teacherRef: id } : { studentRef: id });
  if (!link?.moodleUserId) {
    await audit({ action: "ENROLLMENT_ADDED", outcome: "skipped",
      detail: { reason: "not_provisioned" }, role,
      studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
      moodleUsername: link?.moodleUsername, req, createdBy: "enrollUser" });
    return { ok: true, skipped: true, reason: "not_provisioned" };
  }

  const desired = courseIds || await getCourseIdsFor({ subjects, curriculum, packageName, grade });
  const toAdd = desired.filter((c) => !link.enrolledCourseIds.includes(c));
  if (!toAdd.length) return { ok: true, enrolled: [], alreadyEnrolled: desired };

  const entries = toAdd.map((courseid) => ({ userid: link.moodleUserId, courseid }));
  try {
    await client.enroll(entries);
  } catch (err) {
    await audit({ action: "ENROLLMENT_ADDED", outcome: "failure", failure: err.message,
      role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
      moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername,
      detail: { requested: toAdd }, req, createdBy: "enrollUser" });
    throw err;
  }

  link.enrolledCourseIds = [...new Set([...link.enrolledCourseIds, ...toAdd])];
  link.lastEnrollSyncAt = new Date();
  await link.save();

  await audit({ action: "ENROLLMENT_ADDED", outcome: "success", detail: { added: toAdd },
    role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
    moodleUserId: link.moodleUserId, moodleUsername: link.moodleUsername, req, createdBy: "enrollUser" });

  return { ok: true, enrolled: toAdd, dryRun: config.dryRun, moodleUserId: link.moodleUserId };
}

export default enrollUser;