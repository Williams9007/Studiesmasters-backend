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
    // Tombstone (used:true) left by a previous consume. Mirrors the Mongo
    // store, which keeps its used:true doc until TTL — so a replay stays
    // distinguishable from a never-minted nonce (reserveNonce needs that).
    let seen = null;
    try { seen = JSON.parse(raw); } catch { seen = null; }
    if (seen && seen.used === true) return { ok: false, reason: "reused" };
    const removed = await redis.getDel(key); // atomically read+delete
    if (!removed) return { ok: false, reason: "nonce already consumed" };
    // Leave a tombstone for the remaining TTL so any later replay reads as
    // "reused" instead of looking like a never-minted nonce.
    await redis.set(key, JSON.stringify({ used: true }), { EX: config.nonceTtlSec });
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

/**
 * Admit a CALLER-MINTED nonce on its FIRST sight only (atomic). The Moodle
 * vclass plugin signs with a nonce IT generated (index.php call_backend) —
 * it never asked us to mint one — so claimNonce() can never find those.
 * First sight wins; every later sight is a replay. Identical semantics to
 * claimNonce, just a different source of truth:
 *   - Redis: a SEPARATE keyspace (sso:nonce:seen:) so a reserved nonce can
 *     never leak back through claimNonce() (which delete-on-reads).
 *   - Mongo: the SsoNonce collection with used:true, so claimNonce() rejects
 *     later sights itself as "reused" (duplicate key on the unique nonce).
 */
export async function reserveNonce({ nonce, kind = "student", studentRef }) {
  const redis = await getRedis();
  if (redis) {
    const key = `sso:nonce:seen:${nonce}`;
    const set = await redis.set(key, JSON.stringify({ kind, studentRef: String(studentRef) }), { NX: true, EX: config.nonceTtlSec });
    if (set === "OK") return { ok: true, via: "redis" };
    return { ok: false, reason: "reused" };
  }
  try {
    await SsoNonce.create({
      nonce,
      studentRef,
      kind,
      used: true,
      expiresAt: new Date(Date.now() + config.nonceTtlSec * 1000),
    });
    return { ok: true, via: "mongo" };
  } catch (err) {
    if (err && (err.code === 11000 || /duplicate/i.test(String(err && err.message)))) {
      return { ok: false, reason: "reused" };
    }
    throw err;
  }
}

export const store = { generateNonce, claimNonce, reserveNonce, findOrCreateLink };
export default store;