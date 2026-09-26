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
  const link = await findOrCreateLink({ role, id, userId, email });
  const idnumber = String(id);

  if (!config.dryRun) {
    try {
      // Stable identity is authoritative. Email is consulted only below as a
      // migration fallback for pre-integration accounts.
      let existing = await client.findByStableIdentity({ username: link.moodleUsername, idnumber });
      if (!existing && email) existing = (await client.searchUsersByEmail(email))?.[0] || null;
      if (existing?.id) {
        const identityAdopted = String(existing.username) === link.moodleUsername || String(existing.idnumber) === idnumber;
        logger.info(`Moodle account resolved for ${link.moodleUsername}: id ${existing.id}${identityAdopted ? "" : " (email migration fallback)"}`);
        link.moodleUserId = existing.id;
        link.suspended = false;
        link.active = true;
        link.email = email || link.email;
        if (!link.lastSyncedProfileAt) link.lastSyncedProfileAt = new Date();
        await link.save();
        await audit({ action: "ACCOUNT_CREATED", outcome: "success",
          detail: { moodleUsername: link.moodleUsername, adopted: true, identityAdopted },
          studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
          role, moodleUserId: existing.id, moodleUsername: link.moodleUsername, req, createdBy: "createUser" });
        return { ok: true, link, moodleUserId: existing.id, adopted: true, identityAdopted };
      }
    } catch (err) {
      // A failed read is not permission to blindly create. Stable identity makes
      // Moodle's duplicate error safe, so surface the failure and retry later.
      throw err;
    }
  } else if (link.moodleUserId) {
    logger.info("Moodle user already provisioned, skipping create:", link.moodleUsername, link.moodleUserId);
    return { ok: true, skipped: true, link };
  }

  const nameParts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const firstname = nameParts.shift() || "";
  // Single-named students: use the first name only (Moodle accepts an empty
  // lastname, so the display name isn't doubled like "Lydia Lydia").
  const lastname = nameParts.join(" ");

  let result;
  try {
    // Moodle requires a password on core_user_create_users (or createpassword=1).
    // Students log in via SSO, so a strong random placeholder is fine.
    const password = config.defaultPassword ||
      `Sm!${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6).toUpperCase()}1!`;
    result = await client.createUser({
      username: link.moodleUsername,
      idnumber: String(id),
      firstname,
      lastname,
      email,
      password,
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