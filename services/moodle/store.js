// services/moodle/store.js
//
// Persistence helpers shared by the Moodle services:
//   1. One-time nonce store (Redis preferred, MongoDB fallback with TTL).
//   2. Moodle identity link (MoodleLink) derived from the immutable Mongo id.
//
// Nonce contract:
//   - generateNonce() mints a fresh random token tied to a principal
//   - claimNonce(nonce) is ATOMIC: returns true only the first time; any later
//     reuse is rejected (replay protection).

import crypto from "crypto";
import MoodleLink from "../../models/MoodleLink.js";
import SsoNonce from "../../models/SsoNonce.js";
import { config } from "./config.js";
import logger from "../../utils/logger.js";

// --- Optional Redis client (lazy init) -----------------------------------
let redisClient = null;
let redisAttempted = false;
async function getRedis() {
  if (redisAttempted) return redisClient;
  redisAttempted = true;
  if (!config.redisUrl) return null;
  try {
    // Import lazily so the rest of the platform works without the redis dep.
    const { createClient } = await import("redis");
    redisClient = createClient({ url: config.redisUrl });
    redisClient.on("error", (e) => logger.error("Redis error:", e.message));
    await redisClient.connect();
    logger.info("Redis connected for Moodle nonce store.");
    return redisClient;
  } catch (err) {
    logger.warn("Redis unavailable; falling back to Mongo nonce store:", err.message);
    return null;
  }
}

// --- Stable identity helpers ----------------------------------------------
/**
 * Produce a stable, immutable Moodle username from a principal's Mongo _id.
 * Never derived from email, so an email change is identity-safe.
 */
export function moodleUsernameFor({ role, id, userId = null }) {
  const hex = String(id).replace(/[^a-zA-Z0-9]/g, "");
  const tag = role === "teacher" ? "sm_t" : "sm_s";
  return `${tag}_${hex}`.toLowerCase();
}

export async function findOrCreateLink({ role, id, userId = null, email }) {
  const refKey = role === "teacher" ? { teacherRef: id } : { studentRef: id };
  const moodleUsername = moodleUsernameFor({ role, id, userId });
  const existing = await MoodleLink.findOne(refKey);
  if (existing) {
    if (email && existing.email !== email) existing.email = email;
    if (existing.moodleUsername !== moodleUsername) existing.moodleUsername = moodleUsername; // one-time upgrade guard
    if (!existing.email && email) existing.email = email;
    if (existing.isModified("email") || existing.isModified("moodleUsername")) await existing.save();
    return existing;
  }
  const doc = await MoodleLink.create({
    role,
    studentRef: role === "teacher" ? null : id,
    teacherRef: role === "teacher" ? id : null,
    moodleUsername,
    email: email || "",
  });
  return doc;
}

// --- Nonce store -------------------------------------------------------------
export async function generateNonce({ studentRef, teacherRef = null, kind = "student" }) {
  const nonce = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.nonceTtlSec * 1000);
  const redis = await getRedis();
  if (redis) {
    const key = `sso:nonce:${nonce}`;
    await redis.set(key, JSON.stringify({ studentRef: String(studentRef), kind }), { EX: config.nonceTtlSec });
  } else {
    await SsoNonce.create({ nonce, studentRef, kind, expiresAt });
  }
  return { nonce, expiresAt };
}

/**
 * Atomically consume a nonce. Returns { ok: true, record } on first use,
 * { ok: false, reason } on replay, expiry, or missing nonce.
 */
export async function claimNonce({ nonce, kind = "student" }) {
  const redis = await getRedis();
  if (redis) {
    const key = `sso:nonce:${nonce}`;
    const raw = await redis.get(key);
    if (!raw) return { ok: false, reason: "nonce not found / already consumed" };
    const removed = await redis.getDel(key); // atomically read+delete
    if (!removed) return { ok: false, reason: "nonce already consumed" };
    let rec = null;
    try { rec = JSON.parse(removed); } catch { rec = { kind }; }
    return { ok: true, record: rec, via: "redis" };
  }
  // Mongo fallback: atomic claim via findOneAndUpdate on unused+unexpired.
  const claimed = await SsoNonce.findOneAndUpdate(
    { nonce, kind, used: false, expiresAt: { $gt: new Date() } },
    { $set: { used: true } },
    { new: false }
  );
  if (!claimed) {
    // Distinguish expired vs reused for the audit trail.
    const exists = await SsoNonce.findOne({ nonce }).lean();
    return exists ? (exists.expiresAt < new Date() ? { ok: false, reason: "expired" } : { ok: false, reason: "reused" })
      : { ok: false, reason: "unknown" };
  }
  return { ok: true, record: claimed, via: "mongo" };
}

export const store = { generateNonce, claimNonce, findOrCreateLink };
export default store;