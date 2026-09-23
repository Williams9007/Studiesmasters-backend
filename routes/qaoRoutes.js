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
import ClassSession from "../models/ClassSession.js";
import GoogleAccountAuditLog from "../models/GoogleAccountAuditLog.js";

import { verifyQao } from "../middleware/verifyQao.js";
import { sanitizeClassGroup } from "../services/qao/sanitize.js";

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
      message: subject ? `${subject} â€” ${message}` : message,
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
      .populate("teacher", "fullName email employeeRole employmentStatus")
      .sort({ createdAt: -1 });
    // QAO-safe: student arrays are stripped server-side, only the count is exposed
    res.json({ success: true, groups: groups.map((g) => sanitizeClassGroup(g)) });
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

// ---- Admin Monitoring: Teacher Google Status Dashboard (Phase 6E Enhanced) ----
// Returns all teachers with their Google Meet verification status
// for the Admin/Tutor Manager monitoring dashboard.

/**
 * GET /api/qao/teacher-google-status
 * Admin/Tutor Manager dashboard endpoint showing all teachers' Google Meet status.
 */
router.get("/teacher-google-status", verifyQao, async (req, res) => {
  try {
    // Get all active teachers with Google Meet info
    const teachers = await Teacher.find({
      employmentStatus: { $in: ["active", "on_leave", "suspended"] },
    })
      .select("fullName email googleMeetEmail googleAccountVerified googleVerifiedAt googleOAuthState employeeRole employmentStatus")
      .lean();

    // Get upcoming sessions for each teacher (next 7 days)
    const oneWeekFromNow = new Date();
    oneWeekFromNow.setDate(oneWeekFromNow.getDate() + 7);

    const upcomingSessions = await ClassSession.find({
      teacher: { $in: teachers.map(t => t._id) },
      date: { $gte: new Date() },
      status: { $in: ["scheduled", "live"] },
    })
      .populate("classGroup", "subject grade")
      .select("teacher date startTime endTime coHostStatus googleMeet meetingStatus")
      .lean();

    // Build teacher status with upcoming classes
    const teacherStatus = teachers.map(teacher => {
      const upcomingClasses = upcomingSessions
        .filter(s => String(s.teacher) === String(teacher._id))
        .map(s => ({
          sessionId: s._id,
          subject: s.classGroup?.subject || "Unknown",
          grade: s.classGroup?.grade || "",
          date: s.date,
          startTime: s.startTime,
          endTime: s.endTime,
          coHostStatus: s.coHostStatus,
          meetingStatus: s.meetingStatus,
          hasMeetingLink: !!(s.googleMeet?.meetingLink || s.meetingLink),
        }));

      return {
        teacherId: teacher._id,
        name: teacher.fullName || teacher.name,
        email: teacher.email,
        employeeRole: teacher.employeeRole,
        employmentStatus: teacher.employmentStatus,
        google: {
          email: teacher.googleMeetEmail,
          verified: teacher.googleAccountVerified,
          verifiedAt: teacher.googleVerifiedAt,
          state: teacher.googleOAuthState,
        },
        googleReady: teacher.googleAccountVerified, // Can be co-host
        upcomingClasses: upcomingClasses.slice(0, 10), // Show up to 10 upcoming classes
        hasUnverifiedClasses: upcomingClasses.some(c => c.coHostStatus === "not_configured" || c.coHostStatus === "manual_required"),
      };
    });

    res.json({
      success: true,
      data: teacherStatus,
      summary: {
        total: teacherStatus.length,
        googleConnected: teacherStatus.filter(t => t.googleReady).length,
        needsSetup: teacherStatus.filter(t => !t.googleReady && t.upcomingClasses.length > 0).length,
        hasIssues: teacherStatus.filter(t => t.hasUnverifiedClasses).length,
      },
    });
  } catch (err) {
    console.error("Teacher Google status endpoint error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch teacher Google status",
    });
  }
});

/**
 * GET /api/qao/google-account-audit-log
 * Admin endpoint to view Google account audit log entries.
 */
router.get("/google-account-audit-log", verifyQao, async (req, res) => {
  try {
    const { teacherId, action, limit = 100, days = 30 } = req.query;

    const query = {};
    if (teacherId) query.teacherId = teacherId;
    if (action) query.action = action;

    // Filter by date range
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    query.createdAt = { $gte: startDate };

    const logs = await GoogleAccountAuditLog.find(query)
      .populate("teacherId", "fullName email")
      .populate("performedBy", "fullName email")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      logs: logs.map(log => ({
        id: log._id,
        teacher: log.teacherId ? {
          id: log.teacherId._id,
          name: log.teacherId.fullName || log.teacherId.name,
          email: log.teacherId.email,
        } : null,
        action: log.action,
        googleEmail: log.googleEmail,
        previousGoogleEmail: log.previousGoogleEmail,
        performedBy: log.performedBy ? {
          id: log.performedBy._id,
          name: log.performedBy.fullName || log.performedBy.name,
          email: log.performedBy.email,
        } : null,
        performerRole: log.performerRole,
        ipAddress: log.ipAddress,
        success: log.success,
        errorMessage: log.errorMessage,
        details: log.details,
        timestamp: log.createdAt,
      })),
    });
  } catch (err) {
    console.error("Google audit log endpoint error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch audit log",
    });
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

import tutorManagerRoutes from "./qaoTutorManagerRoutes.js";
import { setSocketIO as setQaoNotifySocket } from "../services/qao/notify.js";

// Extended Tutor Manager (QAO) dashboard endpoints - all under /api/qao/*
router.use(tutorManagerRoutes);

export const setQaoSocket = setQaoNotifySocket;

export default router;






