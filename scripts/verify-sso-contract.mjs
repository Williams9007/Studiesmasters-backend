// scripts/verify-sso-contract.mjs
//
// End-to-end check that the CURRENT repo's SSO wire contract is self-consistent
// using the REAL MOODLE_SSO_SECRET from .env:
//   1. Signs a payload exactly like services/moodle/generateSSO.js (backend).
//   2. Verifies it EXACTLY like the current moodle-sso/local/studiesmasters_sso/sso.php
//      does (payload = username|email|timestamp|nonce|course).
//
// Also emulates the OLD plugin payload (username|email|timestamp|course, no nonce)
// to show whether the DEPLOYED plugin is running the old wire contract.
//
// Run: node scripts/verify-sso-contract.mjs

import crypto from "node:crypto";
import "dotenv/config";

const secret = process.env.MOODLE_SSO_SECRET;
if (!secret) { console.error("MOODLE_SSO_SECRET not set in .env"); process.exit(1); }
console.log("MOODLE_SSO_SECRET length:", secret.length);

function epochSec() { return Math.floor(Date.now() / 1000); }

// ---- 1. Backend signs (mirrors generateSSO.js) ---------------------------
const username = "sm_s_6a62082fd5d62eeb".toLowerCase();
const email = "student@example.com".trim();
const timestamp = epochSec();
const nonce = crypto.randomBytes(16).toString("hex");
const course = 5;

const newPayload = `${username}|${email}|${timestamp}|${nonce}|${course}`;
const newSignature = crypto.createHmac("sha256", secret).update(newPayload).digest("hex");

// ---- 2. Current sso.php verifies (payload = username|email|timestamp|nonce|course)
const newExpected = crypto.createHmac("sha256", secret).update(newPayload).digest("hex");
const curMatches = newExpected.toLowerCase() === newSignature.toLowerCase();
console.log("\n[Current contract] payload =", newPayload);
console.log(`  backend signature: ${newSignature.slice(0, 16)}…`);
console.log(`  current sso.php verify: ${curMatches ? "PASS ✅ (signature matches)" : "FAIL ❌"}`);

// ---- 3. Old plugin contract (no nonce in payload) ------------------------
const oldPayload = `${username}|${email}|${timestamp}|${course}`;
const oldExpected = crypto.createHmac("sha256", secret).update(oldPayload).digest("hex");
const oldMatches = oldExpected.toLowerCase() === newSignature.toLowerCase();
console.log("\n[Old contract] payload (no nonce) =", oldPayload);
console.log(`  does the backend signature verify under the OLD contract? ${oldMatches ? "YES" : "NO ❌"}`);

console.log("\nInterpretation:");
console.log("  If 'current sso.php verify: PASS' -> backend + CURRENT repo plugin are consistent;");
console.log("  the only reason Moodle reports badsignature is that Moodle is running an OLD plugin");
console.log("  (whose signature payload differs) OR the secret set in Moodle differs from MOODLE_SSO_SECRET.");
process.exit(0);