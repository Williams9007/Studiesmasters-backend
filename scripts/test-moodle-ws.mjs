// scripts/test-moodle-ws.mjs
//
// Quick connectivity + auth test against the LIVE Moodle REST Web Services.
// Use this to validate your MOODLE_WS_TOKEN BEFORE running "Provision Moodle",
// so you don't get confusing dry-run results.
//
// Usage:
//   node scripts/test-moodle-ws.mjs
//     (uses MOODLE_WS_TOKEN from .env)
//   node scripts/test-moodle-ws.mjs <token>
//     (uses the token you pass)
//
// Exit 0 = Moodle reachable + token valid. Non-zero = something is wrong.

import "dotenv/config";

const token = process.argv[2] || process.env.MOODLE_WS_TOKEN;
const wsUrl = process.env.MOODLE_WS_URL || `${(process.env.MOODLE_BASE_URL || "").replace(/\/$/, "")}/webservice/rest/server.php`;

if (!token) {
  console.error("❌ No MOODLE_WS_TOKEN set (pass one as an argument or set it in .env).");
  process.exit(2);
}
if (!wsUrl) {
  console.error("❌ No MOODLE_WS_URL / MOODLE_BASE_URL set in .env.");
  process.exit(2);
}

console.log("Testing Moodle WS at:", wsUrl);
console.log("Token length:", token.length);

// Cheap, harmless call — same one the health endpoint uses.
const q = new URLSearchParams({
  wstoken: token,
  moodlewsrestformat: "json",
  wsfunction: "core_user_get_users_by_field",
  field: "id",
  "values[0]": "0",
});

try {
  const resp = await fetch(`${wsUrl}?${q.toString()}`, { method: "GET" });
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }

  if (body?.exception) {
    console.error(`❌ Moodle returned an error: ${body.message || body.errorcode || body.exception}`);
    console.error("   Common causes: wrong token, token not enabled, or the WS function isn't allowed.");
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`❌ HTTP ${resp.status} from Moodle.`, body);
    process.exit(1);
  }
  console.log("✅ Moodle WS reachable and token works. Response:", JSON.stringify(body).slice(0, 200));
  process.exit(0);
} catch (err) {
  console.error("❌ Could not reach Moodle WS:", err.message);
  console.error("   Check MOODLE_WS_URL and that the Moodle server is reachable from the backend.");
  process.exit(1);
}