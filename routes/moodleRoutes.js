// routes/moodleRoutes.js
//
// Single Sign-On (SSO) endpoints that connect the StudiesMasters platform to
// a Moodle LMS (e.g. lms.studiesmasters.com).
//
// Flow:
//   1. A logged-in student/teacher calls GET /api/moodle/sso (or /teacher-sso).
//   2. This route builds a short-lived, JWT-signed Moodle URL (HS256 over the
//      payload { email, firstname, lastname, exp }, signed with MOODLE_SSO_SECRET).
//   3. The frontend opens the returned Moodle URL in a new tab.
//   4. sso.php on the Moodle server verifies the JWT signature (timing-safe) +
//      expiry, provisions the user inside Moodle's MariaDB (mdl_user) if missing,
//      starts a Moodle session for them, and redirects to the course/dashboard.
//
// The secret is SHARED, by value, with the Moodle plugin's "Shared SSO secret"
// setting. If they don't match exactly, Moodle rejects the handshake.
import express from "express";
import jwt from "jsonwebtoken";
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

// Split a full name into Moodle's firstname/lastname fields.
const splitName = (fullName = "") => {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const firstname = parts.shift() || "";
  const lastname = parts.join(" ") || firstname;
  return { firstname, lastname };
};

// Build the signed SSO URL. The Moodle plugin (sso.php) expects:
//   ?token=<HS256 JWT>&course=<id>
// The JWT payload carries { email, firstname, lastname, exp }; it is signed
// with MOODLE_SSO_SECRET (must exactly match the plugin's "Shared SSO secret").
// The plugin verifies the signature with a timing-safe compare, checks exp
// (expires in), finds-or-creates the user in mdl_user, logs them in, then
// redirects to the course (if enrolled) or the Moodle dashboard.
// The `course` param stays as a query param (Moodle reads it via PARAM_INT):
// a positive integer goes straight to that course, else 0 -> dashboard.
const buildSsoUrl = ({ email, fullName, course }) => {
  const emailLower = String(email || "").trim().toLowerCase();
  const { firstname, lastname } = splitName(fullName);

  const courseInt = parseInt(course, 10);
  const courseValue = Number.isInteger(courseInt) && courseInt > 0 ? courseInt : 0;

  const token = jwt.sign(
    { email: emailLower, firstname, lastname },
    getSecret(),
    { expiresIn: "300s" } // matches the plugin's default token lifetime
  );

  const qs = new URLSearchParams({
    token,
    course: String(courseValue),
  });

  return `${getMoodleBase()}${getSsoPath()}?${qs.toString()}`;
};

// The Moodle plugin finds-or-creates the user by username then email, so we use
// the student's (lowercased, unique) email as the stable username identifier.
router.get("/sso", studentAuth, async (req, res) => {
  try {
    const student = await Student.findById(req.user._id).select("email fullName");
    if (!student) return res.status(404).json({ message: "Student not found" });

    const url = buildSsoUrl({ email: student.email, fullName: student.fullName, course: req.query.course });
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

    const url = buildSsoUrl({ email: teacher.email, fullName: teacher.fullName, course: req.query.course });
    return res.json({ url, status: "ok" });
  } catch (err) {
    console.error("Teacher SSO error:", err);
    return res.status(500).json({ message: "Failed to create SSO link" });
  }
});

export default router;