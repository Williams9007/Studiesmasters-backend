import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";

import Student from "../models/Student.js";
import Payment from "../models/Payment.js";
import Subject from "../models/Subject.js";
import Broadcast from "../models/Broadcast.js";
import Assignment from "../models/Assignment.js";
import { sendWelcomeEmail } from "../message/sendWelcomeEmail.js";
import { studentAuth } from "../middleware/studentAuth.js";

dotenv.config();
const router = express.Router();

/* ==================== REGISTER STUDENT ==================== */
router.post("/register", async (req, res) => {
  try {
    const { fullName, email, phone, password, curriculum, package: pkg, grade, subjects, totalAmount, startDate, finishDate, studyDuration } = req.body;

    const selectedSubjects = Array.isArray(subjects) 
      ? subjects 
      : typeof subjects === "string" && subjects.trim() !== "" 
        ? [subjects] 
        : [];

    if (!fullName || !email || !phone || !password || !curriculum || !pkg || !grade || selectedSubjects.length === 0) {
      return res.status(400).json({ message: "All required fields must be provided and at least one subject selected." });
    }

    if (await Student.findOne({ email })) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const foundSubjects = await Subject.find({ _id: { $in: selectedSubjects } });
    if (!foundSubjects.length) return res.status(400).json({ message: "No matching subjects found." });

    const invalidSubjects = foundSubjects.filter(s => 
      (s.package || "").trim().toUpperCase() !== (pkg || "").trim().toUpperCase() || 
      (s.grade || "").trim().toUpperCase() !== (grade || "").trim().toUpperCase()
    );
    if (invalidSubjects.length > 0) return res.status(400).json({ message: "Some subjects do not match package/grade." });

    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));

    const student = new Student({
      fullName,
      email,
      phone,
      password: hashedPassword,
      curriculum,
      package: pkg,
      grade,
      subjectsEnrolled: foundSubjects.map(s => s._id),
      totalAmount,
      startDate,
      finishDate,
      studyDuration
    });

    await student.save();

    await Subject.updateMany(
      { _id: { $in: foundSubjects.map(s => s._id) } }, 
      { $push: { enrolledStudents: student._id } }
    );

    try {
      await sendWelcomeEmail(
        email,
        fullName,
        pkg,
        foundSubjects.map(s => s.name).join(", "),
        startDate || "N/A",
        finishDate || "N/A",
        studyDuration || "3 months"
      );
    } catch (err) {
      console.error("❌ Error sending welcome email:", err);
    }

    const token = jwt.sign({ id: student._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ message: "✅ Student registered successfully", user: student, token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error during student signup" });
  }
});

/* ==================== LOGIN STUDENT ==================== */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const student = await Student.findOne({ email });
    if (!student) return res.status(404).json({ message: "User not found. Please sign up." });

    if (!(await bcrypt.compare(password, student.password))) 
      return res.status(400).json({ message: "Invalid email or password" });

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
    const student = await Student.findById(req.user._id)
      .populate("subjectsEnrolled", "name package grade price")
      .select("-password");
    const payments = await Payment.find({ studentId: student._id }).sort({ createdAt: -1 });
    res.json({ user: student, subjects: student.subjectsEnrolled, payments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching student" });
  }
});

/* ==================== STUDENT SUBJECTS ==================== */
// ✅ FIXED ROUTE: subjects come after studentId
router.get("/subjects/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    const student = await Student.findById(studentId).populate("subjectsEnrolled", "name package grade price");
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json({ success: true, subjects: student.subjectsEnrolled });
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
const upload = multer({ storage });

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
