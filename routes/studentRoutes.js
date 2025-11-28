import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";

import Student from "../models/Student.js";
import Payment from "../models/Payment.js";
import Subject from "../models/Subject.js";
import Broadcast from "../models/Broadcast.js";
import Assignment from "../models/Assignment.js"; // <-- Make sure this exists
import { sendWelcomeEmail } from "../message/sendWelcomeEmail.js";

dotenv.config();
const router = express.Router();

/* ==================== REGISTER STUDENT ==================== */
router.post("/register", async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      password,
      curriculum,
      package: pkg,
      grade,
      subjects,
      totalAmount,
      startDate,
      finishDate,
      studyDuration,
    } = req.body;

    const selectedSubjects = Array.isArray(subjects)
      ? subjects
      : typeof subjects === "string" && subjects.trim() !== ""
      ? [subjects]
      : [];

    if (!fullName || !email || !phone || !password || !curriculum || !pkg || !grade || selectedSubjects.length === 0) {
      return res.status(400).json({ message: "All required fields must be provided and at least one subject selected." });
    }

    const existingStudent = await Student.findOne({ email });
    if (existingStudent) return res.status(400).json({ message: "Email already registered" });

    const foundSubjects = await Subject.find({ _id: { $in: selectedSubjects } });
    if (!foundSubjects.length) return res.status(400).json({ message: "No matching subjects found for the selected IDs." });

    const invalidSubjects = foundSubjects.filter((s) => {
      const subPackage = (s.package || "").trim().toUpperCase();
      const subGrade = (s.grade || "").trim().toUpperCase();
      const payloadPackage = (pkg || "").trim().toUpperCase();
      const payloadGrade = (grade || "").trim().toUpperCase();
      return subPackage !== payloadPackage || subGrade !== payloadGrade;
    });

    if (invalidSubjects.length > 0) {
      return res.status(400).json({ message: "Some selected subjects do not match the chosen curriculum/package/grade." });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const student = new Student({
      fullName,
      email,
      phone,
      password: hashedPassword,
      curriculum,
      package: pkg,
      grade,
      subjectsEnrolled: foundSubjects.map((s) => s._id),
      totalAmount,
      startDate,
      finishDate,
      studyDuration,
    });

    await student.save();

    await Subject.updateMany(
      { _id: { $in: foundSubjects.map((s) => s._id) } },
      { $push: { enrolledStudents: student._id } }
    );

    try {
      await sendWelcomeEmail(
        email,
        fullName,
        pkg,
        foundSubjects.map((s) => s.name).join(", "),
        startDate || "N/A",
        finishDate || "N/A",
        studyDuration || "3 months"
      );
    } catch (emailError) {
      console.error("❌ Error sending welcome email:", emailError);
    }

    const token = jwt.sign({ id: student._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({ message: "✅ Student registered successfully", user: student, token });
  } catch (err) {
    console.error("❌ Student signup error:", err);
    res.status(500).json({ message: "Server error during student signup" });
  }
});

/* ==================== LOGIN STUDENT ==================== */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const student = await Student.findOne({ email });
    if (!student) return res.status(404).json({ message: "User not found. Please sign up." });

    const isMatch = await bcrypt.compare(password, student.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid email or password" });

    const token = jwt.sign({ id: student._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.json({ message: "Login successful", user: student, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error during login" });
  }
});

/* ==================== GET CURRENT STUDENT ==================== */
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const student = await Student.findById(decoded.id)
      .populate("subjectsEnrolled", "name package grade price")
      .select("-password");

    if (!student) return res.status(404).json({ message: "Student not found" });

    const payments = await Payment.find({ studentId: student._id }).sort({ createdAt: -1 });

    res.json({ user: student, subjects: student.subjectsEnrolled, payments });
  } catch (err) {
    console.error("❌ Error fetching current student:", err);
    res.status(500).json({ message: "Server error fetching student" });
  }
});

/* ==================== FETCH STUDENT SUBJECTS ==================== */
router.get("/:studentId/subjects", async (req, res) => {
  try {
    const student = await Student.findById(req.params.studentId)
      .populate("subjectsEnrolled", "name package grade price");

    if (!student) return res.status(404).json({ message: "Student not found" });

    res.json(student.subjectsEnrolled || []);
  } catch (error) {
    console.error("❌ Error fetching student subjects:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ==================== FETCH STUDENT BROADCASTS ==================== */
router.get("/broadcasts/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    const broadcasts = await Broadcast.find({ $or: [{ target: "all" }, { studentId }] }).sort({ createdAt: -1 });
    res.json(broadcasts || []);
  } catch (error) {
    console.error("❌ Error fetching broadcasts:", error);
    res.status(500).json({ message: "Server error fetching broadcasts" });
  }
});

/* ==================== FETCH STUDENT PAYMENTS ==================== */
router.get("/payments/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    const payments = await Payment.find({ studentId }).sort({ createdAt: -1 });
    res.json(payments || []);
  } catch (error) {
    console.error("❌ Error fetching payments:", error);
    res.status(500).json({ message: "Server error fetching payments" });
  }
});

/* ==================== FETCH STUDENT ASSIGNMENTS ==================== */
router.get("/:studentId/assignments", async (req, res) => {
  try {
    const { studentId } = req.params;
    const assignments = await Assignment.find({ studentId }).sort({ createdAt: -1 });
    res.json(assignments || []);
  } catch (error) {
    console.error("❌ Error fetching assignments:", error);
    res.status(500).json({ message: "Server error fetching assignments" });
  }
});


/* ==================== FETCH STUDENT PAYMENTS ==================== */
router.get("/payments/:studentId", async (req, res) => {
  try {
    const payments = await Payment.find({ studentId: req.params.studentId }).sort({ createdAt: -1 });

    // Convert buffer to base64 so frontend can display
    const paymentsWithImages = payments.map((p) => ({
      ...p.toObject(),
      proofImage: p.screenshot.data
        ? `data:${p.screenshot.contentType};base64,${p.screenshot.data.toString("base64")}`
        : null,
    }));

    res.json(paymentsWithImages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching payments" });
  }
});


/* ==================== RENEW / MAKE PAYMENT ==================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/proofs/"),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

router.post("/renew-payment/:studentId", upload.single("proofImage"), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { amount, packageName } = req.body;

    const proofPath = req.file ? `/uploads/proofs/${req.file.filename}` : null;

    const newPayment = new Payment({
      studentId,
      amount,
      package: packageName || "N/A",
      proofImage: proofPath,
      status: "pending",
    });

    await newPayment.save();

    res.status(201).json({ message: "✅ Payment submitted successfully! Awaiting approval.", payment: newPayment });
  } catch (error) {
    console.error("❌ Error renewing payment:", error);
    res.status(500).json({ message: "Server error during payment renewal" });
  }
});

export default router;
