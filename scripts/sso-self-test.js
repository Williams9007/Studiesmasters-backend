/*
 * scripts/sso-self-test.js
 *
 * Local round-trip test for the StudiesMasters <-> Moodle SSO handshake.
 *
 * Why this exists: the signing side lives in routes/moodleRoutes.js (Node) and
 * the verifying side lives on the Moodle server (sso.php). We can't easily call
 * the live Moodle endpoint from a unit test, BUT we can replicate Moodle's
 * verification logic (the exact HMAC + hash_equals + timestamp rules) here and
 * prove that URLs produced by the real buildSsoUrl() are accepted by that
 * verification logic. This catches contract drift locally before you deploy.
 *
 * Run it:
 *   node scripts/sso-self-test.js
 *   node scripts/sso-self-test.js --secret my-shared-secret-here
 */
import crypto from "node:crypto";
import process from "node:process";

// --- Replicate Moodle's sso.php verification (source: moodle-sso/local/.../sso.php) ---
const MAX_CLOCK_SKEW_SECONDS = 300; // ±5 min, must equal the Moodle side tolerance

function verifySsoRedirectUrl(targetUrl, secret) {
  const url = new URL(targetUrl);
  const params = url.searchParams;

  const username  = String(params.get("username") || "").trim().toLowerCase();
  const email     = String(params.get("email") || "").trim();
  const timestamp = Number(params.get("timestamp"));
  const course    = Number(params.get("course") || 0);
  const sig       = String(params.get("signature") || "").trim().toLowerCase();

  // Rule 1: timestamp must be a valid integer.
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "invalid timestamp" };
  }

  // Rule 2: freshness (±5 min). Matches sso.php's abs(time() - timestamp) > 300 check.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: `token expired or too far in future (skew=${now - timestamp}s)` };
  }

  // Rule 3: signature = strtolower(hex(HMAC_SHA256(payload, secret)))
  const payload = `${username}|${email}|${timestamp}|${course}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // Use timing-safe compare (mirrors PHP hash_equals).
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf   = Buffer.from(sig, "hex");
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true, username, email, timestamp, course, payload };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("❌ FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("✅ PASS:", msg);
  }
}

async function main() {
  // --- Load the LIVE signer from the backend so the test exercises real code ---
  const { buildSsoUrl } = await import("../routes/moodleRoutes.js");

  // allow: node script.js                       -> uses the real secret from .env if present
  //        node script.js --secret <shared>      -> uses <shared>
  //        node script.js <shared>               -> uses <shared>
  const explicit = process.argv.slice(2).find((a) => a.startsWith("--secret="))?.split("=")[1] ||
    process.argv.slice(2).find((a) => !a.startsWith("--") && a !== "--");
  const secret = explicit || process.env.MOODLE_SSO_SECRET || "test-shared-secret-123";

  // Force the secret into the env so getSecret() inside moodleRoutes.js resolves it.
  process.env.MOODLE_SSO_SECRET = secret;
  process.env.MOODLE_BASE_URL = process.env.MOODLE_BASE_URL || "https://lms.studiesmasters.com";
  process.env.MOODLE_SSO_PATH = process.env.MOODLE_SSO_PATH || "/local/studiesmasters_sso/sso.php";

  const user = {
    username: "yitige1536@applamos.com",
    email: "yitige1536@applamos.com",
    fullName: "Yiti Ge",
  };

  // --- Case 1: no course (dashboard) ---
  const url1 = buildSsoUrl({ username: user.username, email: user.email, fullName: user.fullName });
  const v1 = verifySsoRedirectUrl(url1, secret);
  assert(v1.ok, `dashboard URL verifies (username=${v1.username})`);

  // --- Case 2: with a course id ---
  const url2 = buildSsoUrl({ ...user, course: "42" });
  const v2 = verifySsoRedirectUrl(url2, secret);
  assert(v2.ok && v2.course === 42, `course=42 URL verifies (course=${v2.course})`);

  // --- Case 3: tampered signature is rejected ---
  const tampered = new URL(url1);
  tampered.searchParams.set("signature", "deadbeef".repeat(8));
  const v3 = verifySsoRedirectUrl(tampered.toString(), secret);
  assert(!v3.ok && v3.reason === "signature mismatch", "tampered signature rejected");

  // --- Case 4: wrong secret is rejected ---
  const v4 = verifySsoRedirectUrl(url1, "wrong-secret");
  assert(!v4.ok && v4.reason === "signature mismatch", "wrong-shared-secret rejected");

  // --- Case 5: payload exactly matches what the signer built ---
  const u = new URL(url1);
  const payload = `${u.searchParams.get("username")}|${u.searchParams.get("email")}|${u.searchParams.get("timestamp")}|${u.searchParams.get("course")}`;
  const recomputed = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  assert(recomputed === u.searchParams.get("signature"), "signature is the HMAC of the canonical payload");

  // --- Case 6: timestamp is epoch seconds (not milliseconds) ---
  const ts = Number(u.searchParams.get("timestamp"));
  assert(String(ts).length <= 11 && ts > 1_700_000_000 && ts < 10_000_000_000, `timestamp is epoch seconds (${ts})`);

  console.log("\nSigned URL sample:", url1);
  console.log(v1.ok ? "\nAll SSO round-trip checks passed." : "\nSome checks FAILED.");
}

main().catch((err) => {
  console.error("❌ Test harness error:", err);
  process.exit(1);
});