import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import nodemailer from "nodemailer";
import User from "../models/User.js";
import Student from "../models/Student.js";
import Admin from "../models/admin.js";
import Teacher from "../models/teacher.js";


const router = express.Router();

// ✅ Load environment variables
import dotenv from "dotenv";
dotenv.config();

// ✅ Create reusable Nodemailer transporter
// Create reusable Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ethereal.email",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // false for port 587
  auth: {
    user: process.env.ETHEREAL_USER,
    pass: process.env.ETHEREAL_PASS,
  },
  tls: {
    rejectUnauthorized: false, // allow self-signed certs
  },
  connectionTimeout: 10000, // 10s timeout
});


// ====================
// 🔹 REGISTER USER
// ====================
router.post("/register", async (req, res) => {
  try {
    const {
      fullName,
      email,
      password,
      role,
      phone,
      curriculum,
      package: userPackage,
      grade,
      subjects,
      amount,
      experience,
      adminCode,
    } = req.body;

    // Check for existing email
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "Email already exists" });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      fullName,
      email,
      password: hashedPassword,
      role,
      phone,
      curriculum,
      package: userPackage,
      grade,
      subjects,
      amount,
      experience,
      adminCode,
    });

    await newUser.save();

    // Generate JWT token
    const token = jwt.sign(
      { id: newUser._id, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    
    

    res.status(201).json({ message: "User registered successfully!", token, user: newUser });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ message: "Server error during registration" });
  }
});


// ================== USER LOGIN ==================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // ✅ Check if student exists
    const student = await Student.findOne({ email });
    if (!student) {
      return res.status(404).json({ message: "No account found with that email" });
    }

    // ✅ Compare password
    const isMatch = await bcrypt.compare(password, student.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid password" });
    }

    // ✅ Generate JWT token
    const token = jwt.sign(
      { id: student._id, role: "student" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: student._id,
        fullName: student.fullName,
        email: student.email,
        role: "student",
        curriculum: student.curriculum,
      },
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ message: "Server error during login" });
  }
});


// ====================
// 🔹 FORGOT PASSWORD
// ====================
router.post("/forget-password", async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 15 * 60 * 1000;
    await user.save({ validateBeforeSave: false });

    const resetUrl = `http://localhost:5173/reset-password/${resetToken}`;

    await transporter.sendMail({
      from: '"EduConnect Support" <no-reply@educonnect.com>',
      to: user.email,
      subject: "Password Reset Request",
      html: `
        <div style="font-family: Arial, sans-serif; line-height:1.6;">
          <p>Dear ${user.fullName},</p>
          <p>To reset your password, click the button below:</p>
          <a href="${resetUrl}" target="_blank" style="background-color:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px;">
            Reset Password
          </a>
          <p style="margin-top:16px;">This link will expire in <strong>15 minutes</strong>.</p>
        </div>
      `,
    });

    res.json({ message: "Password reset email sent successfully!" });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Error sending reset email" });
  }
});

// ====================
// 🔹 RESET PASSWORD
// ====================
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) return res.status(400).json({ message: "Invalid or expired token" });

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;

    await user.save({ validateBeforeSave: false });

    res.json({ message: "Password reset successful!" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Error resetting password" });
  }
});

// ====================
// 🔹 CHANGE PASSWORD (logged in)
// ====================
router.post("/change-password", async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: "Current password is incorrect" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Password updated successfully!" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "Error updating password" });
  }
});

export default router;
