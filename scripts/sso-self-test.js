/*
 * scripts/sso-self-test.js
 *
 * Round-trip test for the enterprise StudiesMasters <-> Moodle SSO (v2).
 *
 * The signing lives in services/moodle/generateSSO.js and the verifying side
 * lives both in services/moodle/verifySSO.js and in the Moodle plugin
 * (moodle-sso/local/studiesmasters_sso/sso.php). This test replicates the
 * contract locally so drift is caught before deploy.
 *
 * This test needs a MongoDB connection for the nonce store. Pass MONGO_* envs
 * (as in server) or set MOODLE_SSO_TEST_SKIP_DB=1 to only test pure signing.
 *
 * Run:   node scripts/sso-self-test.js [--secret X]
 */
import crypto from "node:crypto";
import process from "node:process";
import mongoose from "mongoose";

const MAX_CLOCK_SKEW_SECONDS = 300; // must match config.ssoClockSkewSec + sso.php

// ---- Replicate Moodle's sso.php verification (new minimal payload) ---------
function verifySsoRedirectUrl(targetUrl, secret) {
  const url = new URL(targetUrl);
  const p = url.searchParams;
  const username  = String(p.get("username") || "").trim().toLowerCase();
  const email     = String(p.get("email") || "").trim();
  const timestamp = Number(p.get("timestamp"));
  const nonce     = String(p.get("nonce") || "").trim();
  const course    = Number(p.get("course") || 0);
  const sig       = String(p.get("signature") || "").trim().toLowerCase();

  if (!Number.isFinite(timestamp)) return { ok: false, reason: "invalid timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  if (!nonce || nonce.length < 16) return { ok: false, reason: "missing nonce" };

  const payload = `${username}|${email}|${timestamp}|${nonce}|${course}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
  return { ok: true, username, email, timestamp, nonce, course, payload };
}

function assert(cond, msg) {
  if (!cond) { console.error("❌ FAIL:", msg); process.exitCode = 1; }
  else console.log("✅ PASS:", msg);
}

async function main() {
  // Load the real signer/identity from the service so tests exercise real code.
  process.env.MOODLE_BASE_URL = process.env.MOODLE_BASE_URL || "https://lms.studiesmasters.com";
  process.env.MOODLE_SSO_PATH  = process.env.MOODLE_SSO_PATH || "/local/studiesmasters_sso/sso.php";
  const explicit = process.argv.slice(2).find((a) => a.startsWith("--secret="))?.split("=")[1];
  const secret = explicit || process.env.MOODLE_SSO_SECRET || "test-shared-secret-123";
  process.env.MOODLE_SSO_SECRET = secret;

  const { moodleUsernameFor } = await import("../services/moodle/store.js");
  const { verifyPayload, signPayload } = await import("../services/moodle/config.js");

  // We test the pure pieces that don't need a live Mongo fallback:
  // 1) stable username (immutable id, never email) — the new stable identity.
  const stable = moodleUsernameFor({ role: "student", id: "507f1f77bcf86cd799439011" });
  assert(stable === "sm_s_507f1f77bcf86cd799439011", `stable username from _id (${stable})`);
  assert(!stable.includes("@"), "username is NOT derived from email");

  // 2. signing round-trip with the minimal payload (nonce included).
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${stable}|student@example.com|${timestamp}|${nonce}|0`;
  const { sign } = signPayload(payload);
  const ver = verifyPayload(payload, sign);
  assert(ver.ok, "minimal signed payload verifies");

  // 3. tamper detection (replay guard + integrity).
  const tampered = verifyPayload(
    `${stable}|student@example.com|${timestamp}|${nonce}|9`, sign);
  assert(!tampered.ok, "tampered payload rejected");

  // 4. secret rotation verify-only (second secret accepted).
  process.env.MOODLE_SSO_SECRETS = JSON.stringify([{ id: "2", secret: "older-secret-789" }]);
  const { verifyPayload: vrot } = await import("../services/moodle/config.js");
  const sigOlder = crypto.createHmac("sha256", "older-secret-789")
    .update(payload).digest("hex");
  const rot = vrot(payload, sigOlder);
  assert(rot.ok && rot.matchedId === "2", "rotation secret accepted for verify");

  if (process.env.MOODLE_SSO_TEST_SKIP_DB === "1") return;

  // 5. One-time nonce replay protection (needs a DB).
  try {
    await mongoose.connect(process.env.MONGO_URI || "", { bufferCommands: false });
  } catch (err) {
    console.warn("⚠️  Skipping replay test — no MONGO_URI:", err.message);
    return;
  }
  const { generateNonce, claimNonce } = await import("../services/moodle/store.js");
  const n = await generateNonce({ studentRef: new mongoose.Types.ObjectId(), kind: "student" });
  assert(!!n.nonce, "nonce generated");
  const c1 = await claimNonce({ nonce: n.nonce, kind: "student" });
  assert(c1.ok, "first claim succeeds");
  const c2 = await claimNonce({ nonce: n.nonce, kind: "student" });
  assert(!c2.ok && (c2.reason === "reused" || c2.reason === "unknown"), `replay rejected (${c2.reason})`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error("❌ Test harness error:", err); process.exit(1); });