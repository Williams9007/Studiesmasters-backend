// src/routes/teacherRoutes.js
import express from "express";
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";

import Teacher from "../models/teacher.js";
import Assignment from "../models/Assignment.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import Broadcast from "../models/Broadcast.js";
import ClassEnrollment from "../models/ClassEnrollment.js";
import TeacherAssignment from "../models/TeacherAssignment.js";

// Middleware
import { verifyTurnstile } from "../middleware/verifyTurnstile.js";

// Initialize Router ONCE
const router = express.Router();

// ==================== TEACHER LIST (Admin) ====================
router.get("/", async (req, res) => {
  try {
    const teachers = await Teacher.find().select("-password"); // Don't send passwords
    res.json(teachers);
  } catch (err) {
    console.error("Error fetching teachers:", err);
    res.status(500).json({ message: "Server error fetching teachers" });
  }
});

// ==================== TEACHER LOGIN ====================
router.post("/login", verifyTurnstile, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });

    const teacher = await Teacher.findOne({ email });
    if (!teacher)
      return res.status(404).json({ message: "Teacher not found" });

    const isMatch = await bcrypt.compare(password, teacher.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid email or password" });

    // TODO: Replace with actual JWT generation
    const token = "DUMMY_OR_JWT_TOKEN_HERE"; 

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      data: {
        _id: teacher._id,
        fullName: teacher.fullName,
        email: teacher.email,
        curriculum: teacher.curriculum,
        role: "Teacher",
      },
    });
  } catch (err) {
    console.error("Teacher login error:", err);
    res.status(500).json({ message: "Server error during teacher login" });
  }
});

// ==================== TEACHER SIGNUP ====================
router.post("/", async (req, res) => {
  try {
    const { fullName, email, phone, password, curriculum, experience } = req.body;
    if (!fullName || !email || !phone || !password || !curriculum || !experience) {
      return res.status(400).json({ message: "All required fields must be provided" });
    }

    const existingTeacher = await Teacher.findOne({ email });
    if (existingTeacher) return res.status(400).json({ message: "Email already registered" });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const teacher = await Teacher.create({
      fullName,
      email,
      phone,
      password: hashedPassword,
      subjects: [], // Ensure this matches your Teacher model schema
      curriculum,
      experience,
    });

    // Don't return password hash
    const teacherObj = teacher.toObject();
    delete teacherObj.password;

    res.status(201).json({ user: teacherObj });
  } catch (err) {
    console.error("Teacher signup error:", err);
    res.status(500).json({ message: "Server error during teacher signup" });
  }
});

// ==================== TEACHER DASHBOARD ====================
router.get("/dashboard/:id", async (req, res) => {
  try {
    const teacher = await Teacher.findById(req.params.id)
      .populate("assignmentsGiven")
      .populate("subjectsTeaching")
      .select("-password");
      
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    res.json({ user: teacher });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching teacher dashboard" });
  }
});

router.get("/:id/subjects", async (req, res) => {
  try {
    const teacher = await Teacher.findById(req.params.id).populate("subjectsTeaching");
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    res.json(teacher.subjectsTeaching || []);
  } catch (err) {
    console.error("Error fetching teacher subjects:", err);
    res.status(500).json({ message: "Server error fetching teacher subjects" });
  }
});

router.get("/:id/assignments", async (req, res) => {
  try {
    const assignments = await Assignment.find({ teacherId: req.params.id }).sort({ createdAt: -1 });
    res.json(assignments);
  } catch (err) {
    console.error("Error fetching teacher assignments:", err);
    res.status(500).json({ message: "Server error fetching teacher assignments" });
  }
});

// ==================== FORGOT PASSWORD ====================
router.post("/forget-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const teacher = await Teacher.findOne({ email });
    if (!teacher) return res.status(404).json({ message: "No user found with this email" });

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = Date.now() + 15 * 60 * 1000; // 15 mins

    // FIX: Use 'teacher' variable, not 'student'
    teacher.resetToken = resetToken;
    teacher.resetTokenExpiry = resetTokenExpiry;
    await teacher.save();

    const resetLink = `http://localhost:5173/reset-password/${resetToken}`;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    await transporter.sendMail({
      from: `"EduConnect Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Password Reset Request",
      html: `
        <p>Hello ${teacher.fullName || "Teacher"},</p>
        <p>You requested a password reset. Click the link below to set a new one:</p>
        <a href="${resetLink}" target="_blank" style="background:#4f46e5;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Reset Password</a>
        <p>This link will expire in 15 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `,
    });

    res.json({ message: "✅ Password reset link sent! Check your email." });
  } catch (err) {
    console.error("❌ Error sending password reset email:", err);
    res.status(500).json({ message: "Server error sending reset email" });
  }
});

// ==================== RESET PASSWORD ====================
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    const teacher = await Teacher.findOne({
      resetToken: token,
      resetTokenExpiry: { $gt: Date.now() },
    });

    if (!teacher) return res.status(400).json({ message: "Invalid or expired reset link" });

    const salt = await bcrypt.genSalt(10);
    teacher.password = await bcrypt.hash(newPassword, salt);
    teacher.resetToken = undefined;
    teacher.resetTokenExpiry = undefined;
    await teacher.save();

    res.json({ message: "✅ Password reset successful!" });
  } catch (err) {
    console.error("❌ Error resetting password:", err);
    res.status(500).json({ message: "Server error resetting password" });
  }
});

// ==================== ASSIGNMENT CRUD ====================
router.post("/assignments", async (req, res) => {
  try {
    const { title, description, subjectId, teacherId, dueDate } = req.body;
    if (!title || !description || !subjectId || !teacherId) {
      return res.status(400).json({ message: "All required fields must be provided" });
    }

    const assignment = await Assignment.create({ title, description, subjectId, teacherId, dueDate });
    
    await Teacher.findByIdAndUpdate(teacherId, { $push: { assignmentsGiven: assignment._id } });
    res.status(201).json({ assignment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error creating assignment" });
  }
});

// 🔹 POST /teacher/broadcast
router.post("/teacher/broadcast", async (req, res) => {
  try {
    const { teacherId, subjectId, message } = req.body;
    const teacher = await Teacher.findById(teacherId);
    const subject = await Subject.findById(subjectId);
    if (!teacher || !subject) return res.status(404).json({ message: "Invalid teacher or subject" });

    const broadcast = new Broadcast({ teacher: teacherId, subjectId, message });
    await broadcast.save();
    res.json({ message: "Broadcast sent successfully", broadcast });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error sending broadcast" });
  }
});

// 🔹 GET /teacher/broadcasts/:teacherId
router.get("/teacher/broadcasts/:teacherId", async (req, res) => {
  try {
    const broadcasts = await Broadcast.find({ teacher: req.params.teacherId })
      .populate("subjectId", "name")
      .sort({ createdAt: -1 });
      
    res.json(broadcasts.map((b) => ({
      subjectName: b.subjectId?.name || "General",
      message: b.message,
      createdAt: b.createdAt,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch broadcasts" });
  }
});

// ✅ Get class summary (subjects + student counts)
router.get("/:id/class-summary", async (req, res) => {
  try {
    const subjects = await Subject.find({ teacherId: req.params.id }).lean();
    const summary = await Promise.all(subjects.map(async (subject) => {
      const studentCount = await ClassEnrollment.countDocuments({ subject: subject.name, grade: subject.grade });
      return { subjectName: subject.name, grade: subject.grade, studentCount };
    }));
    res.json(summary);
  } catch (err) {
    console.error("Error fetching teacher class summary:", err);
    res.status(500).json({ message: err.message });
  }
});

// 🧑‍🏫 Get all students assigned to this teacher
router.get("/:id/students", async (req, res) => {
  try {
    const teacherId = req.params.id;
    const assignments = await TeacherAssignment.find({ teacherId }).lean();
    
    if (!assignments.length) return res.status(200).json([]);

    // Build query clauses based on TeacherAssignment data
    const clauses = await Promise.all(assignments.map(async ({ curriculum, package: pkg, grade, subject }) => {
      const subjectIds = await Subject.find({ name: subject }).distinct("_id");
      return { curriculum, package: pkg, grade, subjectsEnrolled: { $in: subjectIds } };
    }));

    const students = await Student.find({ $or: clauses }).select("fullName email grade createdAt");
    
    res.status(200).json(students.map((student) => ({
      _id: student._id,
      name: student.fullName,
      email: student.email,
      className: student.grade,
      createdAt: student.createdAt,
    })));
  } catch (err) {
    console.error("Error fetching teacher students:", err);
    res.status(500).json({ message: "Server error fetching students" });
  }
});

export default router;
