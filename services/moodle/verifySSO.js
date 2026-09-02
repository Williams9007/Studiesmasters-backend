// services/moodle/verifySSO.js
//
// Backend-side verification invoked by the Moodle SSO plugin so it never has to
// trust profile data in the URL. It:
//   1. enforces timestamp freshness,
//   2. verifies the HMAC signature (against all rotation secrets, timing-safe),
//   3. consumes the one-time nonce (replay protection),
//   4. returns the authoritative, freshly-loaded profile from MongoDB.
//
// The plugin calls GET /api/moodle/sso/verify with the signed params it received.

import { verifyPayload, config } from "./config.js";
import { claimNonce } from "./store.js";
import { audit } from "./audit.js";
import MoodleLink from "../../models/MoodleLink.js";

export function isFresh(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > config.ssoClockSkewSec) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, timestamp: ts };
}

export async function verifySSO({ username, email, timestamp, nonce, course = 0, signature, req = null }) {
  const user = String(username || "").trim().toLowerCase();
  const mail = String(email || "").trim();
  const courseValue = Number(course) || 0;

  // 1) Freshness.
  const fresh = isFresh(timestamp);
  if (!fresh.ok) {
    return { ok: false, reason: fresh.reason, username: user };
  }

  // 2) Signature (minimal payload).
  const payload = `${user}|${mail}|${timestamp}|${nonce}|${courseValue}`;
  const sigOk = verifyPayload(payload, signature);
  if (!sigOk.ok) {
    await audit({ action: "LOGIN_FAILED", outcome: "failure",
      failure: "signature mismatch", req, moodleUsername: user });
    return { ok: false, reason: "signature mismatch", step: "signature" };
  }

  // 3) One-time nonce (replay protection).
  const claimed = await claimNonce({ nonce, kind: detectKind(user) });
  if (!claimed.ok) {
    await audit({ action: "SSO_REPLAY_REJECTED", outcome: "failure",
      failure: `nonce ${claimed.reason}`, req, moodleUsername: user });
    return { ok: false, reason: `nonce_${claimed.reason}`, step: "nonce" };
  }

  // 4) Resolve the authoritative principal from Mongo via the stable username.
  const link = await MoodleLink.findOne({ moodleUsername: user });
  const role = link?.role || detectKind(user);
  let profile = null;

  if (role === "teacher" && link?.teacherRef) {
    const Teacher = (await import("../../models/teacher.js")).default;
    profile = await Teacher.findById(link.teacherRef);
  } else if (link?.studentRef) {
    const Student = (await import("../../models/Student.js")).default;
    profile = await Student.findById(link.studentRef);
  }

  await audit({ action: "LOGIN_SUCCESS", outcome: "success",
    detail: { course: courseValue },
    role, studentRef: link?.studentRef || null, teacherRef: link?.teacherRef || null,
    moodleUsername: user, moodleUserId: link?.moodleUserId, req, createdBy: "verifySSO" });

  return {
    ok: true,
    role,
    principalId: (link?.studentRef || link?.teacherRef || null)?.toString(),
    email: mail,
    course: courseValue,
    // Authoritative profile fields (minimal trust placed in the URL).
    profile: profile ? {
      fullName: profile.fullName || profile.name || null,
      email: profile.email || mail,
      curriculum: profile.curriculum || null,
      grade: profile.grade || null,
      package: profile.package || profile.selectedPlan || null,
      subjects: Array.isArray(profile.subjectNames) ? profile.subjectNames : [],
      suspended: !!profile.suspended,
    } : null,
  };
}

function detectKind(username) {
  return String(username || "").startsWith("sm_t") ? "teacher" : "student";
}

export default verifySSO;