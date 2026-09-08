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
    // In live mode, validate the stored id — it may be a stale pseudo-id from
    // an earlier dry-run (or from a wiped Moodle). Re-create if it's not real.
    if (!config.dryRun) {
      try {
        let found = await client.getUsersByField("email", [email || link.email]).catch(() => []);
        let real = (found || []).find((u) => String(u.id) === String(link.moodleUserId));
        if (!real) {
          const bySearch = await client.searchUsersByEmail(email || link.email);
          real = bySearch.find((u) => String(u.id) === String(link.moodleUserId));
          if (!real && bySearch.length) {
            // Account exists under a different id — adopt it.
            logger.info(`Adopting existing Moodle account for ${link.moodleUsername}: id ${bySearch[0].id}`);
            link.moodleUserId = bySearch[0].id;
            await link.save();
            return { ok: true, skipped: true, link, adopted: true };
          }
        }
        if (!real) {
          logger.warn(`Stored moodleUserId ${link.moodleUserId} for ${link.moodleUsername} is stale (dry-run artifact or wiped Moodle). Re-creating.`);
          link.moodleUserId = null;
          await link.save();
        } else {
          logger.info("Moodle user already provisioned, skipping create:", link.moodleUsername, link.moodleUserId);
          return { ok: true, skipped: true, link };
        }
      } catch (err) {
        throw err;
      }
    } else {
      logger.info("Moodle user already provisioned, skipping create:", link.moodleUsername, link.moodleUserId);
      return { ok: true, skipped: true, link };
    }
  }

  // Reconcile first: the account may already exist in Moodle (e.g. created by
  // an earlier partial run) while our stored id was a stale dry-run artifact.
  if (!config.dryRun) {
    try {
      let found = await client.getUsersByField("email", [email || link.email]).catch(() => []);
      let existing = (found || [])[0];
      if (!existing) {
        // getUsersByField can return [] due to profile-visibility rules even
        // when the account exists — fall back to the admin search.
        existing = (await client.searchUsersByEmail(email || link.email))[0];
      }
      if (existing?.id) {
        logger.info(`Adopting existing Moodle account for ${link.moodleUsername}: id ${existing.id}`);
        link.moodleUserId = existing.id;
        link.suspended = false;
        link.active = true;
        link.email = email || link.email;
        if (!link.lastSyncedProfileAt) link.lastSyncedProfileAt = new Date();
        await link.save();
        await audit({ action: "ACCOUNT_CREATED", outcome: "success",
          detail: { moodleUsername: link.moodleUsername, adopted: true },
          studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
          role, moodleUserId: existing.id, moodleUsername: link.moodleUsername, req, createdBy: "createUser" });
        return { ok: true, link, moodleUserId: existing.id, adopted: true };
      }
    } catch (err) { /* lookup failure is non-fatal; fall through to create */ }
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