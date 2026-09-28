import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import rateLimit from "express-rate-limit";
import User from "../models/Users.js";
import Student from "../models/Student.js";
import Admin from "../models/admin.js";
import Teacher from "../models/teacher.js";
import dotenv from "dotenv";
import { verifyToken } from "../middleware/auth.js";
dotenv.config();

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many attempts, please try again after 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

// NOTE: apply the limiter PER AUTH ENDPOINT (below) — NOT with router.use().
// This router is mounted at /api/students AND /api/teachers, so a router-wide
// limiter would count and 429 every student/teacher dashboard request
// (/timetable, /notifications, mark-read...) after just 5 requests per 15 min.

// ✅ Create reusable Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ethereal.email",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.ETHEREAL_USER,
    pass: process.env.ETHEREAL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 10000,
});

// ==================== / FORGOT PASSWORD
router.post("/forget-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Please provide an email address" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // ✅ Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 15 * 60 * 1000; // 15 minutes

    await user.save({ validateBeforeSave: false });

    // ✅ Build reset URL
    const resetUrl = `http://localhost:5173/reset-password/${resetToken}`;

    // ✅ Email HTML content
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">Reset Your Password</h2>
        <p style="color: #555;">You requested to reset your password. Click the button below:</p>
        <a href="${resetUrl}" target="_blank" style="background-color:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px;">Reset Password</a>
        <p style="margin-top:16px; color: #555;">This link will expire in <strong>15 minutes</strong>.</p>
        <p style="color: #888; font-size: 12px; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
      </div>
    `;

    // ✅ Send email
    await transporter.sendMail({
      from: `"Study Masters" <${process.env.ETHEREAL_USER}>`,
      to: email,
      subject: "Password Reset Request",
      html: emailHtml,
    });

    res.status(200).json({ message: "Password reset link sent! Check your email." });
  } catch (error) {
    console.error("Forget password error:", error);
    res.status(500).json({ message: "Failed to send reset link. Try again." });
  }
});

// ==================== / RESET PASSWORD
router.post("/reset-password/:token", authLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    // ✅ Hash new password and save
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

// ==================== / CHANGE PASSWORD (logged in)
router.post("/change-password", authLimiter, async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Password updated successfully!" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "Error updating password" });
  }
});

// ==================== / CHANGE EMAIL — step 1: request (logged in)
// Sends a confirmation link to the NEW address. The account email is NOT
// changed yet, so possession of the new inbox is proven before the swap.
router.post("/change-email", verifyToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { newEmail } = req.body;

    if (!newEmail || !/^\S+@\S+\.\S+$/.test(newEmail)) {
      return res.status(400).json({ message: "A valid new email is required" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const normalized = newEmail.toLowerCase();
    if (normalized === String(user.email).toLowerCase()) {
      return res.status(400).json({ message: "That is already your current email" });
    }

    // Don't let someone move onto an address another account already owns.
    const taken = await User.findOne({ email: normalized });
    if (taken) {
      return res.status(409).json({ message: "That email is already in use" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    user.pendingEmail = normalized;
    user.emailChangeToken = hashedToken;
    user.emailChangeExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    await user.save({ validateBeforeSave: false });

    const base = process.env.FRONTEND_URL || "http://localhost:5173";
    const confirmUrl = `${base.replace(/\/$/, "")}/confirm-email/${token}`;

    try {
      const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL;
      if (process.env.RESEND_API_KEY && fromEmail) {
        await resend.emails.send({
          from: `Studiesmasters <${fromEmail}>`,
          to: normalized,
          subject: "Confirm your new Studiesmasters email address",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color:#333;">Confirm your new email</h2>
              <p style="color:#555;">You asked to change your Studiesmasters account email to <strong>${normalized}</strong>.</p>
              <a href="${confirmUrl}" target="_blank" style="background-color:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px;">Confirm new email</a>
              <p style="margin-top:16px; color:#555;">This link expires in <strong>15 minutes</strong>.</p>
              <p style="color:#888; font-size:12px; margin-top:20px;">If you did not request this, ignore this email and nothing will change.</p>
            </div>`,
        });
      } else {
        // Fallback to Nodemailer/Ethereal for local dev when RESEND_API_KEY is not configured
        await transporter.sendMail({
          from: `"Studiesmasters" <${fromEmail || process.env.ETHEREAL_USER || "noreply@studiesmasters.com"}>`,
          to: normalized,
          subject: "Confirm your new Studiesmasters email address",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color:#333;">Confirm your new email</h2>
              <p style="color:#555;">You asked to change your Studiesmasters account email to <strong>${normalized}</strong>.</p>
              <a href="${confirmUrl}" target="_blank" style="background-color:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px;">Confirm new email</a>
              <p style="margin-top:16px; color:#555;">This link expires in <strong>15 minutes</strong>.</p>
              <p style="color:#888; font-size:12px; margin-top:20px;">If you did not request this, ignore this email and nothing will change.</p>
            </div>`,
        });
      }
    } catch (mailErr) {
      console.warn("⚠️  Email change mail failed:", mailErr.message);
      user.pendingEmail = null;
      user.emailChangeToken = null;
      user.emailChangeExpires = null;
      await user.save({ validateBeforeSave: false });
      return res.status(500).json({ message: "Could not send the confirmation email. Try again." });
    }

    res.json({ message: "Confirmation link sent. Check your new email address." });
  } catch (error) {
    console.error("Change email request error:", error);
    res.status(500).json({ message: "Error requesting email change" });
  }
});

// ==================== / CHANGE EMAIL — step 2: confirm the token
router.post("/confirm-email/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      emailChangeToken: hashedToken,
      emailChangeExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired confirmation link" });
    }

    if (user.pendingEmail) {
      user.email = user.pendingEmail;
    }
    user.pendingEmail = null;
    user.emailChangeToken = null;
    user.emailChangeExpires = null;
    await user.save({ validateBeforeSave: false });

    res.json({ message: "Email address updated successfully!" });
  } catch (error) {
    console.error("Confirm email error:", error);
    res.status(500).json({ message: "Error confirming email change" });
  }
});

export default router;