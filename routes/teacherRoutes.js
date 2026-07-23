// src/routes/teacherRoutes.js
import express from "express";
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import Teacher from "../models/teacher.js";
import Assignment from "../models/Assignment.js";
import Quiz from "../models/Quiz.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import Broadcast from "../models/Broadcast.js";
import ClassEnrollment from "../models/ClassEnrollment.js";
import TeacherAssignment from "../models/TeacherAssignment.js";
import ClassGroup from "../models/ClassGroup.js";
// Middleware
import { verifyTurnstile } from "../middleware/verifyTurnstile.js";
import { createPasswordResetToken, hashPasswordResetToken, sendPasswordResetEmail } from "../utils/passwordReset.js";

// Initialize Router ONCE
const router = express.Router();

const createEmployeeId = (employeeRole) => {
  const prefix = employeeRole === "tutor_manager" ? "SM-TM" : "SM-TUT";
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
};

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
    const { loginId, email, password } = req.body;
    const identifier = (loginId || email || "").trim();
    if (!identifier || !password)
      return res.status(400).json({ message: "Email or User ID and password are required" });

    const teacher = await Teacher.findOne({
      $or: [{ email: identifier.toLowerCase() }, { userId: identifier.toUpperCase() }],
    });

    // ✅ FIX: Check teacher exists AND has a password hash before bcrypt.compare
    if (!teacher || !teacher.password)
      return res.status(401).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, teacher.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid email or password" });

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: "Server configuration error (JWT secret not set)." });
    }

    const token = jwt.sign({ id: teacher._id, role: "teacher" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    const user = {
      _id: teacher._id,
      fullName: teacher.fullName || teacher.name,
      email: teacher.email,
      userId: teacher.userId,
      curriculum: teacher.curriculum,
      role: "teacher",
    };

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user,
      data: user,
    });
  } catch (err) {
    console.error("Teacher login error:", err);
    res.status(500).json({ message: "Server error during teacher login" });
  }
});

// ==================== TEACHER SIGNUP ====================
router.post("/", async (req, res) => {
  try {
    const { fullName, email, phone, password, curriculum, experience, employeeRole = "tutor" } = req.body;
    if (!fullName || !email || !phone || !password || !curriculum || !experience) {
      return res.status(400).json({ message: "All required fields must be provided" });
    }
    const existingTeacher = await Teacher.findOne({ email });
    if (existingTeacher) return res.status(400).json({ message: "Email already registered" });
    if (!["tutor", "tutor_manager"].includes(employeeRole)) {
      return res.status(400).json({ message: "Employee role must be tutor or tutor_manager" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const teacher = await Teacher.create({
      name: fullName,
      fullName,
      email,
      phone,
      password: hashedPassword,
      userId: createEmployeeId(employeeRole),
      employeeRole,
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

// Get teacher's assigned class groups
router.get("/:id/class-groups", async (req, res) => {
  try {
    const groups = await ClassGroup.find({ teacher: req.params.id })
      .populate("students", "fullName createdAt")
      .sort({ createdAt: -1 });
    res.json(groups);
  } catch (err) {
    console.error("Error fetching teacher class groups:", err);
    res.status(500).json({ message: "Server error fetching class groups" });
  }
});

// Get quiz for teacher
router.get("/:id/quizzes", async (req, res) => {
  try {
    const quizzes = await Quiz.find({ teacherId: req.params.id }).sort({ createdAt: -1 });
    res.json(quizzes);
  } catch (err) {
    console.error("Error fetching teacher quizzes:", err);
    res.status(500).json({ message: "Server error fetching quizzes" });
  }
});

// Create assignment for a specific class group
router.post("/assignments/class-group", async (req, res) => {
  try {
    const { teacherId, classGroupId, title, description, subject, dueDate } = req.body;
    if (!teacherId || !classGroupId || !title || !subject || !dueDate) {
      return res.status(400).json({ message: "Teacher ID, class group ID, title, subject, and due date are required" });
    }
    const group = await ClassGroup.findById(classGroupId);
    if (!group) return res.status(404).json({ message: "Class group not found" });
    if (String(group.teacher) !== String(teacherId)) {
      return res.status(403).json({ message: "You are not authorized to assign assignments to this group" });
    }

    const assignment = await Assignment.create({
      title,
      description,
      subject: [subject],
      teacherId,
      classGroup: group._id,
      students: group.students,
      dueDate,
    });

    res.status(201).json({ assignment });
  } catch (err) {
    console.error("Error creating class group assignment:", err);
    res.status(500).json({ message: "Server error creating assignment" });
  }
});

// Create quiz for a specific class group
router.post("/quizzes/class-group", async (req, res) => {
  try {
    const { teacherId, classGroupId, title, description, questions, dueDate, timeLimit } = req.body;
    if (!teacherId || !classGroupId || !title || !questions || !dueDate) {
      return res.status(400).json({ message: "Teacher ID, class group ID, title, questions, and due date are required" });
    }
    const group = await ClassGroup.findById(classGroupId);
    if (!group) return res.status(404).json({ message: "Class group not found" });
    if (String(group.teacher) !== String(teacherId)) {
      return res.status(403).json({ message: "You are not authorized to create quizzes for this group" });
    }

    const quiz = await Quiz.create({
      title,
      description,
      subject: [group.subject],
      questions,
      teacherId,
      classGroup: group._id,
      students: group.students,
      dueDate,
      timeLimit: timeLimit || 30,
    });

    res.status(201).json({ quiz });
  } catch (err) {
    console.error("Error creating class group quiz:", err);
    res.status(500).json({ message: "Server error creating quiz" });
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

    const resetToken = createPasswordResetToken(teacher);
    await teacher.save();
    await sendPasswordResetEmail({ email: teacher.email, name: teacher.fullName, token: resetToken, requestType: "reset your password", role: "teacher" });

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
      resetToken: hashPasswordResetToken(token),
      resetTokenExpiry: { $gt: Date.now() },
    });
    if (!teacher) return res.status(400).json({ message: "Invalid or expired reset link" });

    if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
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

    const students = await Student.find({ $or: clauses }).select("fullName grade createdAt");
    res.status(200).json(students.map((student) => ({
      _id: student._id,
      name: student.fullName,
      className: student.grade,
      createdAt: student.createdAt,
    })));
  } catch (err) {
    console.error("Error fetching teacher students:", err);
    res.status(500).json({ message: "Server error fetching students" });
  }
});

// ✅ REQUIRED: Default export for ESM import in server.js
export default router;
