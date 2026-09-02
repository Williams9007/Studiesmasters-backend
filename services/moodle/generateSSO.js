// services/moodle/generateSSO.js
//
// Mint a minimal, HMAC-signed, one-time SSO redirect URL.
//
// The payload is intentionally small (identity + replay guard + redirect):
//   username | email | timestamp | nonce | course
//
// Any richer profile data is fetched by the Moodle plugin via our verify
// endpoint (backend is the only authority) rather than being embedded in the
// URL. This satisfies "minimize the SSO payload".

import { config, signPayload } from "./config.js";
import { findOrCreateLink, generateNonce } from "./store.js";
import { audit } from "./audit.js";
import crypto from "crypto";

function epochSec() {
  return Math.floor(Date.now() / 1000);
}

export async function generateSSO({ role, id, email, course = 0, fullName = null, userId = null, req = null }) {
  const link = await findOrCreateLink({ role, id, email });

  const { nonce } = await generateNonce({ studentRef: id, kind: role });
  const timestamp = epochSec();
  const courseValue = Number.isInteger(Number(course)) ? Math.max(0, Number(course)) : 0;

  const payload = `${link.moodleUsername}|${String(email || "").trim()}|${timestamp}|${nonce}|${courseValue}`;
  const { sign: signature } = signPayload(payload);

  const qs = new URLSearchParams({
    username: link.moodleUsername,
    email: String(email || "").trim(),
    timestamp: String(timestamp),
    nonce,
    course: String(courseValue),
    signature,
  });

  const url = `${config.baseUrl}${config.ssoPath}?${qs.toString()}`;

  await audit({ action: "SSO_ISSUED", outcome: "success",
    detail: { course: courseValue, dryRun: config.dryRun },
    role, studentRef: role === "student" ? id : null, teacherRef: role === "teacher" ? id : null,
    moodleUsername: link.moodleUsername, req, createdBy: "generateSSO" });

  return { url, username: link.moodleUsername, email: String(email || "").trim(), role, course: courseValue };
}

export default generateSSO;