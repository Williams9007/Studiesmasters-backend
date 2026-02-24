import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import Assignment from "../models/Assignment.js";
import Teacher from "../models/teacher.js";
import Student from "../models/Student.js";

const router = express.Router();
// ==================== TEACHER LOGIN ====================
router.post("/login", async (req, res) => {
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

    // ✅ Return token and role
    res.status(200).json({
      success: true,
      message: "Login successful",
      token: "DUMMY_OR_JWT_TOKEN_HERE", // replace with JWT if needed
      data: {
        _id: teacher._id,
        fullName: teacher.fullName,
        email: teacher.email,
        curriculum: teacher.curriculum,
        role: "Teacher", // important
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
      subjects: [],
      curriculum,
      experience,
    });

    res.status(201).json({ user: teacher });
  } catch (err) {
    console.error("Teacher signup error:", err);
    res.status(500).json({ message: "Server error during teacher signup" });
  }
});

// ==================== TEACHER DASHBOARD ====================
// NEW
router.get("/dashboard/:id", async (req, res) => {
  try {
    const teacherId = req.params.id; // now comes from URL

    if (!teacherId) return res.status(400).json({ message: "Teacher ID required" });

    const teacher = await Teacher.findById(teacherId)
      .populate("assignmentsGiven")
      .populate("subjectsTeaching");

    if (!teacher) return res.status(404).json({ message: "Teacher not found" });

    res.json({ user: teacher });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error fetching teacher dashboard" });
  }
});


// ==================== FORGOT PASSWORD (Send reset link) ====================
router.post("/forget-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const teacher = await Teacher.findOne({ email });
    if (!teacher)
      return res.status(404).json({ message: "No user found with this email" });

    // Generate secure reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = Date.now() + 15 * 60 * 1000; // 15 min expiry

    student.resetToken = resetToken;
    student.resetTokenExpiry = resetTokenExpiry;
    await student.save();

    const resetLink = `http://localhost:5173/reset-password/${resetToken}`;

    // ✅ Gmail transporter instead of Ethereal
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // Send reset email
    await transporter.sendMail({
      from: `"EduConnect Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Password Reset Request",
      html: `
        <p>Hello ${teacher.fullName || "Teacher"},</p>
        <p>You requested a password reset. Click the link below to set a new one:</p>
        <a href="${resetLink}" target="_blank" 
          style="background:#4f46e5;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">
          Reset Password
        </a>
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

    const assignment = await Assignment.create({
      title,
      description,
      subjectId,
      teacherId,
      dueDate,
    });

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

    if (!teacher || !subject) {
      return res.status(404).json({ message: "Invalid teacher or subject" });
    }

    const broadcast = new Broadcast({
      teacher: teacherId,
      subject: subjectId,
      message,
    });
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
      .populate("subject", "name")
      .sort({ createdAt: -1 });

    res.json(
      broadcasts.map((b) => ({
        subjectName: b.subject?.name || "General",
        message: b.message,
        createdAt: b.createdAt,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch broadcasts" });
  }
});

// ✅ Get class summary (subjects + student counts)
router.get("/:id/class-summary", async (req, res) => {
  try {
    const teacherId = req.params.id;

    // Find all subjects this teacher teaches
    const subjects = await Subject.find({ teacherId }).lean();

    // For each subject, count students enrolled
    const summary = await Promise.all(
      subjects.map(async (subject) => {
        const studentCount = await ClassEnrollment.countDocuments({
          subject: subject.name,
          grade: subject.grade,
        });

        return {
          subjectName: subject.name,
          grade: subject.grade,
          studentCount,
        };
      })
    );

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

    // Find subjects the teacher handles
    const teacherSubjects = await Subject.find({ teacherId }).select("_id name grade");

    if (!teacherSubjects.length)
      return res.status(200).json([]); // No subjects yet, so no students

    const subjectIds = teacherSubjects.map((s) => s._id);

    // Find students enrolled in those subjects
    const students = await Student.find({ subjectId: { $in: subjectIds } })
      .populate("subjectId", "name grade")
      .select("name email subjectId createdAt");

    const formatted = students.map((s) => ({
      _id: s._id,
      name: s.name,
      email: s.email,
      subjectName: s.subjectId?.name,
      className: s.subjectId?.grade,
      createdAt: s.createdAt,
    }));

    res.status(200).json(formatted);
  } catch (err) {
    console.error("Error fetching teacher students:", err);
    res.status(500).json({ message: "Server error fetching students" });
  }
});


export default router;
