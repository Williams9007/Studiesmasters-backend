// backend/routes/qaoRoutes.js
import express from "express";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";

import QaoUser from "../models/QaoUser.js"; 
import Teacher from "../models/teacher.js";
import Resource from "../models/Resource.js"; 
import KPI from "../models/Kpi.js";           
import Notification from "../models/Notification.js";
import Message from "../models/Message.js";

import { verifyQao } from "../middleware/verifyQao.js";

dotenv.config();
const router = express.Router();

// -------------------- QAO Access / Login --------------------
router.post("/access", async (req, res) => {
  const { qaoCode } = req.body;

  if (!qaoCode) return res.status(400).json({ success: false, message: "Access code is required" });

  const validCode = process.env.QAO_SECRET_CODE || "QAO2025_SECRET";

  if (qaoCode === validCode) {
    let qao = await QaoUser.findOne({ role: "qao" });
    if (!qao) {
      qao = await QaoUser.create({
        name: "Default QAO",
        email: "qao@example.com",
        role: "qao"
      });
    }

    const token = jwt.sign({ id: qao._id, role: "qao" }, process.env.JWT_SECRET, { expiresIn: "8h" });

    return res.json({ success: true, message: "QAO access granted", token, user: { id: qao._id, name: qao.name, email: qao.email } });
  }

  return res.status(401).json({ success: false, message: "Invalid QAO access code" });
});

// -------------------- Broadcast Messages --------------------
router.post("/broadcast", verifyQao, async (req, res) => {
  try {
    const { recipients, subject, message } = req.body;
    const senderId = req.user._id;

    if (!recipients?.length) return res.status(400).json({ success: false, message: "No recipients provided" });

    const messages = recipients.map((receiverId) => ({
      sender: senderId,
      receiver: receiverId,
      subject,
      message,
      senderRole: "qao",
      receiverRole: "teacher",
    }));

    await Message.insertMany(messages);

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

// -------------------- Fetch Sent / Inbox Messages --------------------
router.get("/sent", verifyQao, async (req, res) => {
  try {
    const messages = await Message.find({ sender: req.user._id })
      .populate("receiver", "fullName email role")
      .sort({ createdAt: -1 });

    res.json({ success: true, messages });
  } catch (err) {
    console.error("Fetch sent messages error:", err);
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
    const qaoUsers = await QaoUser.find().select("name email assignedSubjects");
    res.json({ success: true, qaoUsers });
  } catch (err) {
    console.error("QAO fetch users error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/teachers", verifyQao, async (req, res) => {
  try {
    const teachers = await Teacher.find().select("fullName email subjects");
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
    const resource = await Resource.findByIdAndUpdate(req.params.id, { approved }, { new: true });
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
router.get("/notifications", verifyQao, async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient: req.user._id, read: false }).sort({ createdAt: -1 });
    res.json({ success: true, notifications });
  } catch (err) {
    console.error("Fetch notifications error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
