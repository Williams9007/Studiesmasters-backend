// routes/moodleRoutes.js
//
// Single Sign-On (SSO) endpoints that connect the StudiesMasters platform to
// a Moodle LMS (e.g. lms.studiesmasters.com).
//
// Flow:
//   1. A logged-in student/teacher calls GET /api/moodle/sso (or /teacher-sso).
//   2. This route builds a short-lived, HMAC-signed Moodle URL
//      (payload = username|email|timestamp|course, signed with MOODLE_SSO_SECRET).
//   3. The frontend opens the returned Moodle URL in a new tab.
//   4. sso.php on the Moodle server verifies the HMAC signature + expiry,
//      provisions the user inside Moodle's MariaDB (mdl_user) if missing,
//      starts a Moodle session for them, and redirects to the course/dashboard.
//
// The secret is SHARED, by value, with the Moodle plugin's "Shared SSO secret"
// setting. If they don't match exactly, Moodle rejects the handshake.
import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import { studentAuth } from "../middleware/studentAuth.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";

dotenv.config();
const router = express.Router();

const getSecret = () => {
  if (!process.env.MOODLE_SSO_SECRET) {
    throw new Error("MOODLE_SSO_SECRET is not set. Add it to your .env file.");
  }
  return process.env.MOODLE_SSO_SECRET;
};

const getMoodleBase = () =>
  (process.env.MOODLE_BASE_URL || "https://lms.studiesmasters.com").replace(/\/$/, "");

const getSsoPath = () => {
  const p = process.env.MOODLE_SSO_PATH || "/local/studiesmasters_sso/sso.php";
  return p.startsWith("/") ? p : `/${p}`;
};

// Build the signed SSO URL for the Moodle plugin (sso.php). This implements the
// EXACT wire contract verified by the LIVE plugin on lms.studiesmasters.com
// (source of truth — do not change without updating the live server):
//   Method : GET redirect
//   Params : username, email, timestamp, course, optional firstname, lastname, role, signature
//   Normalization (pre-signing):
//     username = strtolower(trim(username))
//     email    = trim(email)               (NOT lowercased)
//   Payload : "{username}|{email}|{timestamp}|{course}"  (normalized, exactly as sent)
//   Signature : strtolower(hex(HMAC_SHA256(payload, secret)))
//   Timestamp : epoch seconds (10 digits — milliseconds fail with tokenexpired)
//   Lifetime : ±300s clock tolerance
//   Success  : HTTP 303 redirect + session cookie (auto-login)
//   Failure  : HTTP 404 (Moodle error page)
const buildSsoUrl = ({ username, email, fullName, course, role }) => {
  const usernameLower = String(username || "").trim().toLowerCase();
  const emailTrimmed = String(email || "").trim();
  // Moodle reads course via PARAM_INT: positive integer, else 0 (dashboard).
  const courseInt = parseInt(course, 10);
  const courseValue = Number.isInteger(courseInt) && courseInt > 0 ? courseInt : 0;
  const timestamp = Math.floor(Date.now() / 1000); // epoch SECONDS, not ms

  const payload = `${usernameLower}|${emailTrimmed}|${timestamp}|${courseValue}`;
  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");

  const nameParts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const firstname = nameParts.shift() || "";
  const lastname = nameParts.join(" ") || firstname;

  const qs = new URLSearchParams({
    username: usernameLower,
    email: emailTrimmed,
    timestamp: String(timestamp),
    course: String(courseValue),
    signature,
  });
  if (firstname) qs.set("firstname", firstname);
  if (lastname) qs.set("lastname", lastname);
  if (role) qs.set("role", role);

  return `${getMoodleBase()}${getSsoPath()}?${qs.toString()}`;
};

// The Moodle plugin finds-or-creates the user by username then email, so we use
// the student's (lowercased, unique) email as the stable username identifier.
router.get("/sso", studentAuth, async (req, res) => {
  try {
    const student = await Student.findById(req.user._id).select("email fullName");
    if (!student) return res.status(404).json({ message: "Student not found" });

    const url = buildSsoUrl({ username: student.email, email: student.email, fullName: student.fullName, course: req.query.course, role: "student" });
    return res.json({ url, email: student.email, role: "student" });
  } catch (err) {
    console.error("Student SSO error:", err);
    return res.status(500).json({ message: "Unable to create SSO link" });
  }
});

router.get("/teacher-sso", verifyTeacher, async (req, res) => {
  try {
    const teacher = await Teacher.findById(req.user._id).select("email fullName");
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });

    const url = buildSsoUrl({ username: teacher.email, email: teacher.email, fullName: teacher.fullName, course: req.query.course, role: "teacher" });
    return res.json({ url, status: "ok" });
  } catch (err) {
    console.error("Teacher SSO error:", err);
    return res.status(500).json({ message: "Failed to create SSO link" });
  }
});

// Exported for testing / reuse (e.g. the SSO self-test in scripts/sso-self-test.js).
export { buildSsoUrl };
export default router;