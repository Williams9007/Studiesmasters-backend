import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

import Student from "../models/Student.js";
import Payment from "../models/Payment.js";
import Subject from "../models/Subject.js";
import Broadcast from "../models/Broadcast.js";
import Assignment from "../models/Assignment.js";
import { sendWelcomeEmail } from "../message/sendWelcomeEmail.js";
import { studentAuth } from "../middleware/studentAuth.js";
import { verifyTurnstile } from "../middleware/verifyTurnstile.js";
import { curriculumCatalog } from "../data/curriculumCatalog.js";
import { createPasswordResetToken, hashPasswordResetToken, sendPasswordResetEmail } from "../utils/passwordReset.js";

dotenv.config();
const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many attempts, please try again after 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

const createUserId = () =>
  `SM-ST-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

router.get("/catalog", (req, res) => res.json(curriculumCatalog));

// A reset link is deliberately required before a password can be changed.
router.post("/forget-password", async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ message: "Email is required" });

    const student = await Student.findOne({ email });
    // Do not disclose whether an email address has an account.
    if (!student) return res.json({ message: "If that email has an account, a confirmation link has been sent." });

    const token = createPasswordResetToken(student);
    await student.save({ validateBeforeSave: false });
    await sendPasswordResetEmail({ email: student.email, name: student.fullName, token, requestType: "reset your password", role: "student" });
    res.json({ message: "Check your email for a link to confirm your password reset." });
  } catch (err) {
    console.error("Student password-reset request error:", err);
    res.status(500).json({ message: "Unable to send the confirmation email" });
  }
});

router.post("/reset-password/:token", async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }
    const student = await Student.findOne({
      resetToken: hashPasswordResetToken(req.params.token),
      resetTokenExpiry: { $gt: new Date() },
    });
    if (!student) return res.status(400).json({ message: "This confirmation link is invalid or has expired" });

    student.password = await bcrypt.hash(newPassword, 10);
    student.resetToken = undefined;
    student.resetTokenExpiry = undefined;
    await student.save();
    res.json({ message: "Password updated successfully. You can now log in." });
  } catch (err) {
    console.error("Student password reset error:", err);
    res.status(500).json({ message: "Unable to update password" });
  }
});

router.post("/change-password/request", studentAuth, async (req, res) => {
  try {
    const student = await Student.findById(req.user._id);
    const token = createPasswordResetToken(student);
    await student.save({ validateBeforeSave: false });
    await sendPasswordResetEmail({ email: student.email, name: student.fullName, token, requestType: "change your password", role: "student" });
    res.json({ message: "Check your email to confirm the password change." });
  } catch (err) {
    console.error("Student password-change request error:", err);
    res.status(500).json({ message: "Unable to send the confirmation email" });
  }
});

/* ==================== REGISTER STUDENT ==================== */
router.post("/register", async (req, res) => {
  try {
    const { fullName, email, phone, curriculum, package: pkg, grade, subjects, selectedPlan = "", totalAmount, startDate, finishDate, studyDuration, preferredDays = [], preferredTime = "", policyAcceptance = {} } = req.body;

    // Validate input
    const selectedSubjects = Array.isArray(subjects) ? subjects : typeof subjects === "string" && subjects.trim() !== "" ? [subjects] : [];
    const catalog = curriculumCatalog[curriculum];
    
    console.log("[Registration] Starting registration for:", { email, curriculum, grade, pkg, subjectsCount: selectedSubjects.length });

    if (!fullName || !email || !phone || !curriculum || !pkg || !grade || selectedSubjects.length === 0) {
      return res.status(400).json({ message: "All required fields must be provided and at least one subject selected." });
    }
    if (!policyAcceptance.terms || !policyAcceptance.privacy || !policyAcceptance.parentAgreement) {
      return res.status(400).json({ message: "You must accept the Terms & Conditions, Privacy Policy, and Parent Service Agreement to continue." });
    }
    if (!catalog || !catalog.grades.includes(grade) || selectedSubjects.some((subject) => !catalog.subjects.includes(subject))) {
      return res.status(400).json({ message: "Select a valid curriculum, grade, and subject." });
    }

    const validLearningDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    if (!Array.isArray(preferredDays)) {
      return res.status(400).json({ message: "Students must select exactly 3 valid learning days each week." });
    }
    const uniquePreferredDays = [...new Set(preferredDays)];
    if (preferredDays.length !== 3 || uniquePreferredDays.length !== 3 || uniquePreferredDays.some((day) => !validLearningDays.includes(day))) {
      return res.status(400).json({ message: "Students must select exactly 3 valid learning days each week." });
    }

    // Check if email already exists
    const existingStudent = await Student.findOne({ email });
    if (existingStudent) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Create or find subjects with proper error handling
    console.log("[Registration] Creating/finding subjects:", selectedSubjects);
    const foundSubjects = await Promise.all(selectedSubjects.map(async (name) => {
      try {
        const subject = await Subject.findOneAndUpdate(
          { name, curriculum: curriculum || "", grade, package: pkg },
          { $setOnInsert: { name, curriculum: curriculum || "", grade, package: pkg, price: 0 } },
          { new: true, upsert: true }
        );
        return subject;
      } catch (subjErr) {
        console.error(`[Registration] Error processing subject '${name}':`, subjErr.message);
        throw new Error(`Failed to process subject '${name}': ${subjErr.message}`);
      }
    }));

    // Check if any subject upsert failed
    if (foundSubjects.some((s) => !s)) {
      console.error("[Registration] One or more subjects are null after upsert");
      return res.status(500).json({ message: "Failed to create or find subjects. Please try again." });
    }

    const temporaryPassword = `SM-${crypto.randomBytes(9).toString("base64url")}`;
    console.log("[Registration] Hashing password...");
    const hashedPassword = await bcrypt.hash(temporaryPassword, await bcrypt.genSalt(10));

    // Create student document (only include fields that have values)
    const student = new Student({
      fullName, email, phone, password: hashedPassword, userId: createUserId(),
      curriculum, package: pkg, selectedPlan, grade,
      subjectsEnrolled: foundSubjects.map(s => s._id),
      subjectNames: selectedSubjects,
      totalAmount: totalAmount || 0,
      startDate: startDate || null,
      finishDate: finishDate || null,
      studyDuration: studyDuration || "",
      preferredDays: uniquePreferredDays,
      preferredTime: preferredTime || "",
      policyAcceptance: {
        terms: true,
        privacy: true,
        parentAgreement: true,
        acceptedAt: new Date(),
      },
    });

    console.log("[Registration] Saving student to database...");
    await student.save();
    console.log("[Registration] Student saved successfully:", student._id);

    // Wait for Resend to acknowledge the request before returning the response.
    let welcomeEmail = { sent: false };
    try {
      const emailData = await sendWelcomeEmail({
        userEmail: email,
        studentName: fullName,
        // The auth form's selected plan is the customer-facing package name.
        // Keep `pkg` as a fallback for older clients that do not send it.
        packageName: selectedPlan || pkg,
        subjects: foundSubjects.map(s => s.name).join(", "),
        temporaryPassword,
        userId: student.userId,
        phone,
        curriculum,
        grade,
        preferredDays: uniquePreferredDays.join(", "),
        preferredTime,
      });
      welcomeEmail = { sent: true, id: emailData?.id };
    } catch (emailErr) {
      console.error("Welcome email failed after student registration:", {
        studentId: student._id.toString(),
        email,
        message: emailErr.message,
      });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: "Server configuration error (JWT secret not set)" });
    }

    const token = jwt.sign({ id: student._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    console.log("[Registration] Student registration completed successfully");
    res.status(201).json({
      message: "✅ Student registered successfully",
      user: student,
      token,
      welcomeEmail,
    });

  } catch (err) {
    console.error("❌ [Registration] Student registration error:", {
      message: err.message,
      name: err.name,
      code: err.code,
      stack: err.stack
    });
    
    if (err?.code === 11000) {
      return res.status(400).json({ message: "An account with this email already exists." });
    }
    if (err?.name === "ValidationError") {
      return res.status(400).json({ message: `Validation error: ${err.message}` });
    }
    if (err?.name === "CastError") {
      return res.status(400).json({ message: `Invalid data format: ${err.message}` });
    }
    
    res.status(500).json({
      message: "Server error during student signup",
      error: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

router.get("/me", studentAuth, async (req, res) => {
  try {
    const student = await Student.findById(req.user._id).populate("subjectsEnrolled", "name package grade price").select("-password");
    const payments = await Payment.find({ studentId: student._id }).sort({ createdAt: -1 });
    res.json({ user: student, subjects: student.subjectsEnrolled, payments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching student" });
  }
});

router.get("/:studentId/payment-summary", async (req, res) => {
  try {
    const student = await Student.findById(req.params.studentId)
      .populate("subjectsEnrolled", "name subjectName")
      .select("fullName userId email phone curriculum package selectedPlan grade subjectsEnrolled preferredDays preferredTime");
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json({ student: {
      id: student._id, userId: student.userId, fullName: student.fullName, email: student.email, phone: student.phone,
      curriculum: student.curriculum, package: student.selectedPlan || student.package, grade: student.grade,
      subjects: student.subjectsEnrolled.map((subject) => subject.name || subject.subjectName),
      preferredDays: student.preferredDays, preferredTime: student.preferredTime,
    } });
  } catch (err) {
    res.status(500).json({ message: "Unable to load payment details" });
  }
});

/* ==================== LOGIN STUDENT ==================== */
router.post("/login", verifyTurnstile, authLimiter, async (req, res) => {
  try {
    const { loginId, email, password } = req.body;
    const identifier = (loginId || email || "").trim();
    if (!identifier || !password) return res.status(400).json({ message: "Email or User ID and password are required" });
    const student = await Student.findOne({
      $or: [{ email: identifier.toLowerCase() }, { userId: identifier.toUpperCase() }],
    });
    if (!student) return res.status(404).json({ message: "User not found. Please sign up." });

    if (!(await bcrypt.compare(password, student.password))) return res.status(400).json({ message: "Invalid email or password" });

    const token = jwt.sign({ id: student._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ message: "Login successful", user: student, token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error during login" });
  }
});

/* ==================== CURRENT STUDENT ==================== */
router.get("/me", studentAuth, async (req, res) => {
  try {
    const student = await Student.findById(req.user._id).populate("subjectsEnrolled", "name package grade price").select("-password");
    const payments = await Payment.find({ studentId: student._id }).sort({ createdAt: -1 });
    res.json({ user: student, subjects: student.subjectsEnrolled, payments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching student" });
  }
});

/* ==================== STUDENT SUBJECTS ==================== */
router.get("/:studentId/subjects", async (req, res) => {
  try {
    const student = await Student.findById(req.params.studentId).populate("subjectsEnrolled", "name package grade price");
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json(student.subjectsEnrolled);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching subjects" });
  }
});

/* ==================== STUDENT BROADCASTS ==================== */
router.get("/broadcasts/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    const broadcasts = await Broadcast.find({
      $or: [{ type: "all" }, { type: "students" }, { recipients: studentId }]
    })
      .sort({ createdAt: -1 })
      .populate("sender", "fullName email");
    res.json({ success: true, broadcasts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching broadcasts" });
  }
});

/* ==================== STUDENT PAYMENTS ==================== */
router.get("/payments/:studentId", async (req, res) => {
  try {
    const payments = await Payment.find({ studentId: req.params.studentId }).sort({ createdAt: -1 });
    const paymentsWithImages = payments.map(p => ({
      ...p.toObject(),
      proofImage: p.screenshot?.data ? `data:${p.screenshot.contentType};base64,${p.screenshot.data.toString("base64")}` : null
    }));
    res.json(paymentsWithImages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching payments" });
  }
});

/* ==================== STUDENT ASSIGNMENTS ==================== */
router.get("/assignments/:studentId", async (req, res) => {
  try {
    const assignments = await Assignment.find({ studentId: req.params.studentId }).sort({ createdAt: -1 });
    res.json(assignments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching assignments" });
  }
});

/* ==================== RENEW / MAKE PAYMENT ==================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/proofs/"),
  filename: (req, file, cb) => cb(null, file.fieldname + "-" + Date.now() + path.extname(file.originalname))
});

const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error("Invalid file type. Only JPG, PNG, WEBP, and PDF are allowed."), false);
    }
    cb(null, true);
  },
});

router.post("/renew-payment/:studentId", upload.single("proofImage"), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { amount, packageName } = req.body;

    const proofPath = req.file ? `/uploads/proofs/${req.file.filename}` : null;

    const newPayment = new Payment({ studentId, amount, package: packageName || "N/A", proofImage: proofPath, status: "pending" });
    await newPayment.save();

    res.status(201).json({ message: "✅ Payment submitted successfully! Awaiting approval.", payment: newPayment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error during payment renewal" });
  }
});

export default router;
