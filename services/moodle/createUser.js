// services/moodle/createUser.js
//
// Provision a Moodle user from a MongoDB principal. The backend is the ONLY
// authority: Moodle merely reflects what we push. Idempotent — if the link
// already has a moodleUserId we return the existing record instead of creating
// a duplicate (prevents duplicate account creation on retries).

import { client } from "./client.js";
import { findOrCreateLink } from "./store.js";
import { audit } from "./audit.js";
import { config } from "./config.js";
import crypto from "crypto";
import logger from "../../utils/logger.js";

// Deterministic pseudo Moodle id for dry-run so downstream ops still exercise
// the flow without a live Moodle.
function pseudoId(username) {
  return (parseInt(crypto.createHash("sha1").update(username).digest("hex").slice(0, 8), 16) % 999000) + 1000;
}

export async function createUser({ role, id, email, fullName, userId = null, req = null }) {
  const link = await findOrCreateLink({ role, id, email });

  if (link.moodleUserId) {
    logger.info("Moodle user already provisioned, skipping create:", link.moodleUsername, link.moodleUserId);
    return { ok: true, skipped: true, link };
  }

  const nameParts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const firstname = nameParts.shift() || "";
  const lastname = nameParts.join(" ") || firstname;

  let result;
  try {
    result = await client.createUser({
      username: link.moodleUsername,
      idnumber: String(id),
      firstname,
      lastname,
      email,
    });
  } catch (err) {
    await audit({ action: "ACCOUNT_CREATED", outcome: "failure", failure: err.message,
      studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
      role, moodleUsername: link.moodleUsername, req, createdBy: "createUser" });
    throw err;
  }

  const moodleUserId = result?.dryRun ? pseudoId(link.moodleUsername) : (result?.id || null);
  link.moodleUserId = moodleUserId;
  link.suspended = false;
  link.active = true;
  link.email = email || link.email;
  if (!link.lastSyncedProfileAt) link.lastSyncedProfileAt = new Date();
  await link.save();

  await audit({ action: "ACCOUNT_CREATED", outcome: "success",
    detail: { moodleUsername: link.moodleUsername, dryRun: !!result?.dryRun },
    studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
    role, moodleUserId, moodleUsername: link.moodleUsername, req, createdBy: "createUser" });

  return { ok: true, link, moodleUserId, dryRun: !!result?.dryRun };
}

export default createUser;