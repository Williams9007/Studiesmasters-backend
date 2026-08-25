// routes/moodleRoutes.js
//
// Single Sign-On (SSO) endpoints that connect the StudiesMasters platform to
// a Moodle LMS (e.g. lms.studiesmasters.com).
//
// Flow:
//   1. A logged-in student/teacher calls GET /api/moodle/sso (or /teacher-sso).
//   2. This route builds a short-lived signed URL for the Moodle plugin
//      (payload = username|email|timestamp|course, signed with HMAC-SHA256
//      using MOODLE_SSO_SECRET).
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

// Build the signed SSO URL using EXACTLY the payload format the Moodle plugin
// expects (documented on the Moodle side of the handshake):
//   username   = strtolower(trim(username))
//   payload    = username + "|" + email + "|" + timestamp + "|" + course
//   signature  = hex( HMAC_SHA256( payload, MOODLE_SSO_SECRET ) )
// Moodle verifies with a timing-safe compare and rejects expired tokens.
// The timestamp is epoch seconds; Moodle's default lifetime is 300s.
const buildSsoUrl = ({ username, email, course }) => {
  const usernameLower = String(username || "").trim().toLowerCase();
  const emailLower = String(email || "").trim().toLowerCase();
  // Moodle reads course via PARAM_INT: keep it a positive integer, else 0
  // (which sends the user to the dashboard). A Mongo _id is NOT a valid course.
  const courseInt = parseInt(course, 10);
  const courseValue = Number.isInteger(courseInt) && courseInt > 0 ? courseInt : 0;
  const timestamp = Math.floor(Date.now() / 1000);

  const payload = `${usernameLower}|${emailLower}|${timestamp}|${courseValue}`;
  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");

  const qs = new URLSearchParams({
    username: usernameLower,
    email: emailLower,
    timestamp: String(timestamp),
    course: String(courseValue),
    signature,
  });

  return `${getMoodleBase()}${getSsoPath()}?${qs.toString()}`;
};

// The Moodle plugin finds-or-creates the user by username then email, so we use
// the student's (lowercased, unique) email as the stable username identifier.
router.get("/sso", studentAuth, async (req, res) => {
  try {
    const student = await Student.findById(req.user._id).select("email fullName");
    if (!student) return res.status(404).json({ message: "Student not found" });

    const url = buildSsoUrl({ username: student.email, email: student.email, course: req.query.course });
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

    const url = buildSsoUrl({ username: teacher.email, email: teacher.email, course: req.query.course });
    return res.json({ url, status: "ok" });
  } catch (err) {
    console.error("Teacher SSO error:", err);
    return res.status(500).json({ message: "Failed to create SSO link" });
  }
});

export default router;