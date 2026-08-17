// backend/routes/qaoRoutes.js
import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";

import QaoUser from "../models/QaoUser.js"; 
import Teacher from "../models/teacher.js";
import Resource from "../models/Resource.js"; 
import KPI from "../models/Kpi.js";           
import Notification from "../models/Notification.js";
import Message from "../models/Message.js";
import MessageRecipient from "../models/MessageRecipient.js";
import ClassGroup from "../models/ClassGroup.js";

import { verifyQao } from "../middleware/verifyQao.js";

dotenv.config();
const router = express.Router();

// -------------------- Tutor Manager Login (email + password) --------------------
router.post("/access", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required" });
  }

  try {
    const qao = await QaoUser.findOne({ email: email.toLowerCase().trim() });

    if (!qao) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, qao.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: qao._id, role: "qao" },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({
      success: true,
      message: "Login successful",
      token,
      user: { id: qao._id, name: qao.name, email: qao.email, role: qao.role, userId: qao.userId },
    });
  } catch (err) {
    console.error("Tutor Manager login error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- Broadcast Messages --------------------
router.post("/broadcast", verifyQao, async (req, res) => {
  try {
    const { recipients, subject, message } = req.body;
    const senderId = req.user._id;

    if (!recipients?.length)
      return res.status(400).json({ success: false, message: "No recipients provided" });

    const messageDocs = await Message.insertMany(
      recipients.map((receiverId) => ({
        sender: senderId,
        receiver: receiverId,
        subject,
        body: message,
        senderRole: "qao",
        receiverRole: "teacher",
      }))
    );

    await MessageRecipient.insertMany(
      messageDocs.map((m) => ({
        message: m._id,
        recipient: m.receiver,
      }))
    );

    // Email notification (optional)
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      for (const receiverId of recipients) {
        const teacher = await Teacher.findById(receiverId);
        if (teacher?.email) {
          await transporter.sendMail({
            from: `"EduConnect QAO" <${process.env.SMTP_USER}>`,
            to: teacher.email,
            subject,
            text: message,
          });
        }
      }
    }

    res.json({ success: true, message: "Messages sent successfully" });
  } catch (err) {
    console.error("Broadcast error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- Broadcast to a Class Group --------------------
// Used when a teacher is unavailable (e.g. sick) so the tutor manager can
// notify the class that a substitute will be covering the lesson.
router.post("/broadcast/class", verifyQao, async (req, res) => {
  try {
    const { classGroupId, subject, message } = req.body;
    const senderId = req.user._id;

    if (!classGroupId) {
      return res.status(400).json({ success: false, message: "Class group is required" });
    }
    if (!subject?.trim() || !message?.trim()) {
      return res.status(400).json({ success: false, message: "Subject and message are required" });
    }

    const classGroup = await ClassGroup.findById(classGroupId);
    if (!classGroup) {
      return res.status(404).json({ success: false, message: "Class group not found" });
    }

    const studentIds = classGroup.students || [];
    if (studentIds.length === 0) {
      return res.status(400).json({ success: false, message: "This class group has no students" });
    }

    // Create a Notification for each student in the class
    const notifications = studentIds.map((studentId) => ({
      userId: studentId,
      type: "broadcast",
      message: subject ? `${subject} — ${message}` : message,
      read: false,
    }));
    await Notification.insertMany(notifications);

    // Also create Message records so it appears in sent history
    const messageDocs = await Message.insertMany(
      studentIds.map((studentId) => ({
        sender: senderId,
        receiver: studentId,
        subject,
        body: message,
        senderRole: "qao",
        receiverRole: "student",
      }))
    );

    await MessageRecipient.insertMany(
      messageDocs.map((m) => ({
        message: m._id,
        recipient: m.receiver,
      }))
    );

    res.json({
      success: true,
      message: `Broadcast sent to ${studentIds.length} student(s) in ${classGroup.code}`,
      recipientCount: studentIds.length,
    });
  } catch (err) {
    console.error("Broadcast to class error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- Fetch Sent / Inbox Messages --------------------
router.get("/sent", verifyQao, async (req, res) => {
  try {
    const messages = await Message.find({ sender: req.user._id })
      .populate("receiver", "fullName email")
      .sort({ createdAt: -1 });

    res.json({ success: true, messages });
  } catch (err) {
    console.error("Fetch sent messages error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/messages/:messageId", verifyQao, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }
    
    // Verify the message was sent by this QAO user
    if (String(message.sender) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: "Not authorized to delete this message" });
    }
    
    // Delete the message and its recipient records
    await MessageRecipient.deleteMany({ message: req.params.messageId });
    await Message.findByIdAndDelete(req.params.messageId);
    
    res.json({ success: true, message: "Message deleted successfully" });
  } catch (err) {
    console.error("Delete message error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/inbox", verifyQao, async (req, res) => {
  try {
    const messages = await Message.find({ receiver: req.user._id })
      .populate("sender", "fullName email role")
      .sort({ createdAt: -1 });

    res.json({ success: true, messages });
  } catch (err) {
    console.error("Fetch inbox messages error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- Fetch Users & Teachers --------------------
router.get("/users", verifyQao, async (req, res) => {
  try {
    const qaoUsers = await QaoUser.find().select("name email assignedSubjects role");
    res.json({ success: true, qaoUsers });
  } catch (err) {
    console.error("QAO fetch users error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/teachers", verifyQao, async (req, res) => {
  try {
    const teachers = await Teacher.find().select("fullName email curriculum");
    res.json({ success: true, teachers });
  } catch (err) {
    console.error("Fetch teachers error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- Resources --------------------
router.get("/resources", verifyQao, async (req, res) => {
  try {
    const resources = await Resource.find()
      .populate("teacher", "fullName")
      .sort({ createdAt: -1 });
    res.json({ success: true, resources });
  } catch (err) {
    console.error("Fetch resources error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put("/resources/:id", verifyQao, async (req, res) => {
  try {
    const { approved } = req.body;
    const resource = await Resource.findByIdAndUpdate(
      req.params.id,
      { approved },
      { new: true }
    );
    res.json({ success: true, resource });
  } catch (err) {
    console.error("Update resource error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- KPI --------------------
router.get("/kpis", verifyQao, async (req, res) => {
  try {
    const kpis = await KPI.find().sort({ createdAt: -1 });
    res.json({ success: true, kpis });
  } catch (err) {
    console.error("Fetch KPI error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- Notifications --------------------
router.get("/class-groups", verifyQao, async (req, res) => {
  try {
    const groups = await ClassGroup.find()
      .populate("teacher", "fullName email")
      .populate("students", "fullName email phone grade")
      .sort({ createdAt: -1 });
    res.json({ success: true, groups: groups.map((group) => ({ ...group.toObject(), studentCount: group.students.length })) });
  } catch (err) {
    console.error("Fetch class groups error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/notifications", verifyQao, async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, notifications });
  } catch (err) {
    console.error("Fetch notifications error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.patch("/notifications/:id/read", verifyQao, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.json({ success: true, notification });
  } catch (err) {
    console.error("Mark notification as read error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.patch("/notifications/read-all", verifyQao, async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.user._id, read: false }, { read: true });
    res.json({ success: true });
  } catch (err) {
    console.error("Mark all notifications as read error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
