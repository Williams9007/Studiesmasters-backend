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
import Notification from "../models/Notification.js";
import ClassSession from "../models/ClassSession.js";
import Timetable from "../models/Timetable.js";
// Middleware
import { verifyTurnstile } from "../middleware/verifyTurnstile.js";
import { createPasswordResetToken, hashPasswordResetToken, sendPasswordResetEmail } from "../utils/passwordReset.js";
import { adminAuth } from "../middleware/adminAuth.js";

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

    const token = jwt.sign(
      { id: teacher._id, role: "teacher", email: teacher.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
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

    // Auto-assign subjects based on curriculum
    const catalog = curriculumCatalog[curriculum];
    const subjectDocs = catalog
      ? await Subject.find({ name: { $in: catalog.subjects }, curriculum }).lean()
      : [];

    const subjectIds = (catalog?.subjects || []).map((name) => {
      const found = subjectDocs.find((s) => s.name === name);
      return found ? found._id : null;
    }).filter(Boolean);

    const teacher = await Teacher.create({
      name: fullName,
      fullName,
      email,
      phone,
      password: hashedPassword,
      userId: createEmployeeId(employeeRole),
      employeeRole,
      curriculum,
      experience,
      subjectsTeaching: subjectIds,
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
    // `subjectsTeaching` is an array of ObjectId refs. Selecting it WITHOUT
    // populating returned raw ids, so the teacher dashboard (and the timetable
    // upload dropdown) rendered a blank subject name for every assigned subject.
    const teacher = await Teacher.findById(req.params.id)
      .select("subjectsTeaching curriculum")
      .populate("subjectsTeaching", "name curriculum grade package price moodleCourseId");
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });

    // If subjectsTeaching is populated, return it
    if (teacher.subjectsTeaching && teacher.subjectsTeaching.length > 0) {
      // Defensive: an id whose Subject document was deleted populates to null.
      return res.json(teacher.subjectsTeaching.filter(Boolean));
    }

    // Fallback: try to get subjects from Subject collection where teacherId matches
    const subjects = await Subject.find({ teacherId: req.params.id }).select("name grade package curriculum price moodleCourseId").lean();
    if (subjects.length > 0) {
      return res.json(subjects.map(s => ({ ...s, _id: s._id || s.name })));
    }

    // If still no subjects, return empty array
    res.json([]);
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
    const { teacherId, classGroupId, message } = req.body;
    const teacher = await Teacher.findById(teacherId);
    const classGroup = await ClassGroup.findById(classGroupId);
    if (!teacher || !classGroup) return res.status(404).json({ message: "Invalid teacher or class group" });

    // Send to all students in the class group
    const broadcast = new Broadcast({
      teacher: teacherId,
      classGroup: classGroupId,
      subjectId: classGroup.subject,
      message,
      type: "class-group",
      recipients: classGroup.students,
      recipientsCount: classGroup.students.length,
    });
    await broadcast.save();

    // Emit to all students in the class group
    if (io) {
      classGroup.students.forEach((studentId) => {
        io.to(studentId.toString()).emit("broadcast:new", {
          message,
          subjectName: classGroup.subject,
          sender: teacher.fullName,
        });
      });
    }

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

    // Try to get students from TeacherAssignment records
    const assignments = await TeacherAssignment.find({ teacherId }).lean();

    // Also try to get students from ClassGroups where this teacher is assigned
    const classGroups = await ClassGroup.find({ teacher: teacherId }).populate("students", "fullName grade createdAt").lean();

    const studentSet = new Map();

    // Add students from TeacherAssignments
    if (assignments.length > 0) {
      const clauses = await Promise.all(assignments.map(async ({ curriculum, package: pkg, grade, subject }) => {
        const subjectIds = await Subject.find({ name: subject }).distinct("_id");
        return { curriculum, package: pkg, grade, subjectsEnrolled: { $in: subjectIds } };
      }));

      const studentsFromAssignments = await Student.find({ $or: clauses }).select("fullName grade createdAt").lean();
      studentsFromAssignments.forEach((s) => {
        studentSet.set(s._id.toString(), { _id: s._id, name: s.fullName, className: s.grade, createdAt: s.createdAt });
      });
    }

    // Add students from ClassGroups
    classGroups.forEach((group) => {
      if (group.students && Array.isArray(group.students)) {
        group.students.forEach((s) => {
          if (!studentSet.has(s._id.toString())) {
            studentSet.set(s._id.toString(), { _id: s._id, name: s.fullName, className: s.grade || "N/A", createdAt: s.createdAt });
          }
        });
      }
    });

    const students = Array.from(studentSet.values());
    res.status(200).json(students);
  } catch (err) {
    console.error("Error fetching teacher students:", err);
    res.status(500).json({ message: "Server error fetching students" });
  }
});

// ─── MY TIMETABLE (teacher) ──────────────────────────────────────────────────
/**
 * GET /api/teachers/:id/timetable
 * This week's classes (Mon–Sun) where the teacher is the main teacher OR the
 * substitute — all statuses, so the dashboard calendar shows the full week.
 */
router.get("/:id/timetable", async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date();
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 7);

    const sessions = await ClassSession.find({
      $or: [{ teacher: id }, { substituteTeacher: id }],
      date: { $gte: monday, $lt: sunday },
    })
      .populate("classGroup", "code subject grade")
      .populate("substituteTeacher", "_id")
      .sort({ date: 1, startTime: 1 })
      .lean();

    res.json({
      success: true,
      timetable: sessions.map((s) => {
        const subId = s.substituteTeacher?._id || s.substituteTeacher;
        return {
          id: s._id,
          date: s.date,
          startTime: s.startTime,
          endTime: s.endTime,
          status: s.status,
          subject: s.classGroup?.subject || "Class",
          grade: s.classGroup?.grade || "",
          groupCode: s.classGroup?.code || "",
          isSubstitute: Boolean(subId && String(subId) === String(id)),
          meetingStatus: s.meetingStatus,
        };
      }),
    });
  } catch (err) {
    console.error("Teacher timetable error:", err);
    res.status(500).json({ success: false, message: "Failed to load timetable" });
  }
});

// ── TIMETABLE SUBMISSION (teacher uploads, Tutor Manager reviews) ───────────
/**
 * GET /api/teachers/:id/timetables
 * The teacher's own uploaded-timetable records + review status, so the
 * dashboard can show "Pending / Approved / Flagged" and any QAO feedback.
 */
router.get("/:id/timetables", async (req, res) => {
  try {
    const { id } = req.params;
    const records = await Timetable.find({ teacherId: id })
      .populate("subjectId", "name curriculum grade")
      .sort({ uploadedAt: -1 })
      .lean();
    res.json({
      success: true,
      timetables: records.map((t) => ({
        id: t._id,
        subject: t.subjectId?.name || "",
        curriculum: t.subjectId?.curriculum || "",
        classLevel: t.classLevel || "",
        fileUrl: t.fileUrl || "",
        status: t.status || "Pending",
        feedback: t.feedback || "",
        uploadedAt: t.uploadedAt,
      })),
    });
  } catch (err) {
    console.error("Teacher timetable records error:", err);
    res.status(500).json({ success: false, message: "Failed to load timetable records" });
  }
});

/**
 * POST /api/teachers/:id/timetables
 * Teacher feeds in a timetable (file URL + subject + class level). The record is
 * created as "Pending" and the Tutor Managers are notified immediately
 * (durable notification + socket event + web push) so nothing sits unreviewed.
 *
 * Body: { subjectId, classLevel, fileUrl }
 */
router.post("/:id/timetables", async (req, res) => {
  try {
    const { id } = req.params;
    const { subjectId, classLevel, fileUrl } = req.body || {};

    if (!subjectId) return res.status(400).json({ success: false, message: "subjectId is required" });
    if (!fileUrl) return res.status(400).json({ success: false, message: "fileUrl is required" });

    const [teacherDoc, subjectDoc] = await Promise.all([
      Teacher.findById(id).select("fullName name email").lean(),
      Subject.findById(subjectId).select("name curriculum grade").lean(),
    ]);
    if (!teacherDoc) return res.status(404).json({ success: false, message: "Teacher not found" });
    if (!subjectDoc) return res.status(404).json({ success: false, message: "Subject not found" });

    const record = await Timetable.create({
      teacherId: id,
      subjectId,
      classLevel: classLevel || "",
      fileUrl,
      status: "Pending",
    });

    const teacherName = teacherDoc.fullName || teacherDoc.name || "A teacher";
    const scope = `${subjectDoc.name || "Timetable"}${classLevel ? ` (${classLevel})` : ""}`;

    // Tutor Manager notification centre: durable record + realtime event.
    try {
      await notifyAllQaos({
        title: "Timetable submitted for review",
        message: `${teacherName} submitted a timetable for ${scope}. Review it in Timetable Approvals.`,
        type: "info",
        emitEvent: "timetable:submitted",
      });
      emitToQaos("timetable:submitted", { timetableId: record._id, teacher: teacherName, subject: subjectDoc.name || "" });
    } catch { /* a notification failure must never lose the submission */ }

    // Best-effort web push to subscribed Tutor Managers.
    try {
      // The project is referenced with inconsistent casing by the TypeScript compiler.
      // @ts-ignore TS1149: preserve the runtime import path while suppressing the casing diagnostic.
      const push = await import("../Controllers/pushNotificationController.js");
      if (typeof push.sendPushToQaos === "function") {
        await push
          .sendPushToQaos("Timetable submitted for review", `${teacherName}: ${scope}`, "/qao/dashboard")
          .catch(() => {});
      }
    } catch { /* push is best-effort */ }

    // Confirm the submission back to the teacher (durable + socket).
    try {
      await notifyTeacher({
        teacherId: id,
        title: "Timetable submitted",
        message: `Your ${scope} timetable was submitted and is awaiting Tutor Manager review.`,
        type: "info",
      });
      emitToTeacher(id, "timetable:submitted", { timetableId: record._id, status: "Pending" });
    } catch { /* non-fatal */ }

    res.status(201).json({
      success: true,
      timetable: {
        id: record._id,
        subject: subjectDoc.name || "",
        classLevel: record.classLevel,
        fileUrl: record.fileUrl,
        status: record.status,
        uploadedAt: record.uploadedAt,
      },
    });
  } catch (err) {
    console.error("Teacher timetable submit error:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── CLASS RECORDS (attendance + performance) ────────────────────────────────
/**
 * GET /api/teachers/:id/performance
 * Per-student attendance record across the teacher's class groups, computed
 * from ClassSession.attendance — which is fed by BOTH the main website
 * (/api/meet/join|leave) AND the Moodle virtual classroom (/api/moodle/vclass/*),
 * so this is the single merged record regardless of where the class was
 * attended or taught.
 */
router.get("/:id/performance", async (req, res) => {
  try {
    const { id } = req.params;
    const groups = await ClassGroup.find({ teacher: id }).populate("students", "fullName").lean();
    const groupIds = groups.map((g) => g._id);
    if (!groupIds.length) return res.json({ success: true, performance: [] });

    const sessions = await ClassSession.find({
      classGroup: { $in: groupIds },
      status: { $in: ["completed", "live"] },
    })
      .select("classGroup attendance status date startTime")
      .sort({ date: -1 })
      .lean();

    const byGroup = new Map();
    for (const s of sessions) {
      const key = String(s.classGroup);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(s);
    }

    const performance = [];
    for (const g of groups) {
      const groupSessions = byGroup.get(String(g._id)) || [];
      const total = groupSessions.length;
      for (const st of g.students || []) {
        let attended = 0;
        let minutes = 0;
        let last = null;
        for (const s of groupSessions) {
          const rec = (s.attendance || []).find((a) => String(a.student) === String(st._id));
          if (rec) {
            attended += 1;
            minutes += rec.duration || 0;
            const at = rec.joinedAt || s.date;
            if (!last || new Date(at) > new Date(last)) last = at;
          }
        }
        performance.push({
          studentId: st._id,
          name: st.fullName || "Student",
          classGroup: g.code,
          subject: g.subject,
          totalSessions: total,
          attended,
          attendancePct: total ? Math.round((attended / total) * 100) : 0,
          minutes,
          lastAttended: last,
        });
      }
    }
    performance.sort((a, b) => b.attendancePct - a.attendancePct || a.name.localeCompare(b.name));
    res.json({ success: true, performance });
  } catch (err) {
    console.error("Teacher performance error:", err);
    res.status(500).json({ success: false, message: "Failed to load class records" });
  }
});

// ─── TEACHER NOTIFICATIONS ────────────────────────────────────────────────────
// Uses the shared notification.service.js so every teacher notification is
// durable (Notification doc) + emitted via socket (notification:new) + ready
// for push integration.

import {
  notifyTeacher,
  notifyAllQaos,
  listForUser,
  markRead,
  markAllRead,
  unreadCount,
  deleteNotification,
  clearNotifications,
} from "../services/qao/notification.service.js";
import { emitToTeacher, emitToQaos } from "../services/qao/notify.js";

router.get("/:id/notifications", async (req, res) => {
  try {
    const { id } = req.params;
    const { limit } = req.query;
    const notifications = await listForUser({
      userId: id,
      role: "teacher",
      limit: Number(limit) || 50,
    });
    res.json({ success: true, notifications });
  } catch (err) {
    console.error("Teacher notifications fetch error:", err);
    res.status(500).json({ message: "Server error fetching notifications" });
  }
});

router.patch("/:id/notifications/:notifId/read", async (req, res) => {
  try {
    const { id, notifId } = req.params;
    const n = await markRead({ notificationId: notifId, userId: id });
    res.json({ success: true, notification: n });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

router.patch("/:id/notifications/read-all", async (req, res) => {
  try {
    const { id } = req.params;
    await markAllRead({ userId: id, role: "teacher" });
    res.json({ success: true });
  } catch (err) {
    console.error("Mark all teacher notifications read error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/:id/notifications/unread-count", async (req, res) => {
  try {
    const { id } = req.params;
    const count = await unreadCount({ userId: id, role: "teacher" });
    res.json({ success: true, count });
  } catch (err) {
    console.error("Teacher unread count error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/** DELETE /api/teachers/:id/notifications/:notifId - dismiss one notification */
router.delete("/:id/notifications/:notifId", async (req, res) => {
  try {
    const { id, notifId } = req.params;
    await deleteNotification({ notificationId: notifId, userId: id });
    res.json({ success: true, deleted: notifId });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/teachers/:id/notifications - clear old notifications.
 * Default keeps unread ones; pass ?all=true to wipe everything.
 */
router.delete("/:id/notifications", async (req, res) => {
  try {
    const { id } = req.params;
    const onlyRead = req.query.all !== "true";
    const result = await clearNotifications({ userId: id, role: "teacher", onlyRead });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Clear teacher notifications error:", err);
    res.status(500).json({ success: false, message: "Failed to clear notifications" });
  }
});

// ---- Admin: Set Teacher Google Account (Phase 6E) ----
// PUT /api/teachers/:id/google-account
// Admin endpoint to set/verify a teacher's Google Meet email
// This is used when an admin wants to pre-set a teacher's Google email
// before the teacher completes OAuth verification.

/**
 * PUT /api/teachers/:id/google-account
 * Admin sets a teacher's Google Meet email (pre-verification setup).
 * The teacher still needs to verify via OAuth, but this sets the expected email.
 */
router.put("/:id/google-account", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { googleMeetEmail } = req.body;

    if (!googleMeetEmail || typeof googleMeetEmail !== "string") {
      return res.status(400).json({
        success: false,
        message: "googleMeetEmail is required and must be a string",
      });
    }

    // Validate email format
    const emailRegex = /^[^@]+@[^@]+\.[^@]+$/;
    if (!emailRegex.test(googleMeetEmail)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    // Find teacher
    const teacher = await Teacher.findById(id);
    if (!teacher) {
      return res.status(404).json({
        success: false,
        message: "Teacher not found",
      });
    }

    // Update teacher's Google account info
    const update = {
      googleMeetEmail: googleMeetEmail.toLowerCase().trim(),
      googleOAuthState: "pending", // Reset to pending for re-verification
    };

    // If the email matches what the teacher will verify, we can mark as pre-verified
    // But actual verification still requires OAuth flow
    await Teacher.findByIdAndUpdate(id, {
      $set: update,
    });

    res.json({
      success: true,
      message: "Google Meet email set. Teacher must still verify via OAuth.",
      data: {
        googleMeetEmail: update.googleMeetEmail,
        googleOAuthState: update.googleOAuthState,
        note: "Teacher needs to complete OAuth verification to use co-host features",
      },
    });
  } catch (err) {
    console.error("Admin set teacher Google account error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to set teacher Google account",
    });
  }
});

// ---------------------------------------------------------------------------
// Teacher Replacement Endpoint (Phase 6.8) - Admin only
// PUT /api/teachers/replacement
// Replaces a teacher in a class session, updating co-host assignment
// ---------------------------------------------------------------------------
/**
 * PUT /api/teachers/replacement
 * Replace teacher in a class session (e.g., teacher leaving, sick leave).
 * Updates ClassSession, Google Calendar attendees, and preserves meeting link/recording.
 */
router.put("/replacement", adminAuth, async (req, res) => {
  try {
    const { sessionId, oldTeacherId, newTeacherId } = req.body;

    if (!sessionId || !oldTeacherId || !newTeacherId) {
      return res.status(400).json({
        success: false,
        message: "sessionId, oldTeacherId, and newTeacherId are required",
      });
    }

    // Fetch both teachers
    const [session, oldTeacher, newTeacher] = await Promise.all([
      ClassSession.findById(sessionId),
      Teacher.findById(oldTeacherId),
      Teacher.findById(newTeacherId),
    ]);

    if (!session) {
      return res.status(404).json({ success: false, message: "Class session not found" });
    }
    if (!oldTeacher) {
      return res.status(404).json({ success: false, message: "Old teacher not found" });
    }
    if (!newTeacher) {
      return res.status(404).json({ success: false, message: "New teacher not found" });
    }

    // Store previous state for audit
    const previousState = {
      teacher: session.teacher,
      teacherEmail: session.googleMeet?.teacherEmail,
      coHostStatus: session.coHostStatus,
    };

    // Update the session teacher
    session.teacher = newTeacherId;
    session.originalTeacher = oldTeacherId; // preserve history
    const newEmail = newTeacher.googleMeetEmail || null;

    // Update googleMeet teacher info
    if (session.googleMeet) {
      session.googleMeet.teacherEmail = newEmail;
    }

    // Update co-host status based on new teacher's verification
    if (newTeacher.googleAccountVerified && newEmail) {
      session.coHostStatus = "invited";
    } else {
      session.coHostStatus = "manual_required";
    }

    await session.save();

    // Update Google Calendar attendees if event exists
    let calendarUpdated = false;
    if (session.googleMeet?.calendarEventId) {
      try {
        const { updateMeetingAttendees } = await import("../services/google/calendar-attendee.service.js");
        await updateMeetingAttendees({
          calendarEventId: session.googleMeet.calendarEventId,
          oldTeacherEmail: oldTeacher.googleMeetEmail,
          newTeacherEmail: newEmail,
        });
        calendarUpdated = true;
      } catch (calendarErr) {
        console.error("Calendar attendee update failed:", calendarErr.message);
        // Don't fail the request - mark as partial success
      }
    }

    // Swap Meet API co-host membership: revoke the old teacher's COHOST role
    // (so they can no longer manage the class) and promote the new teacher.
    // Both are best-effort — never fail the replacement if the Meet API errs.
    let coHostSwapped = false;
    if (session.conferenceId || session.meetingCode || session.googleMeet?.conferenceId || session.googleMeet?.meetingCode) {
      try {
        const { removeMemberFromMeeting, promoteTeacherToCohost } = await import("../services/google/meet.service.js");
        const spaceKeys = {
          conferenceId: session.conferenceId || session.googleMeet?.conferenceId,
          meetingCode: session.meetingCode || session.googleMeet?.meetingCode,
        };
        if (oldTeacher.googleMeetEmail) {
          const removal = await removeMemberFromMeeting({ ...spaceKeys, email: oldTeacher.googleMeetEmail });
          if (!removal.removed) {
            console.warn(`Old teacher Meet member removal failed: ${removal.reason}`);
          }
        }
        if (newTeacher.googleAccountVerified && newEmail) {
          const promo = await promoteTeacherToCohost({ ...spaceKeys, teacherEmail: newEmail });
          if (promo.promoted) {
            session.coHostStatus = "active";
            await session.save();
            coHostSwapped = true;
          } else {
            console.warn(`New teacher co-host promotion pending: ${promo.reason}`);
          }
        }
      } catch (coHostErr) {
        console.error("Meet co-host swap failed (non-fatal):", coHostErr.message);
      }
    }

    // Log the replacement via QAO action logger
    try {
      const { logQaoAction } = await import("../services/qao/audit.service.js");
      await logQaoAction({
        action: "TEACHER_REPLACED",
        resource: "ClassSession",
        resourceId: sessionId,
        details: {
          oldTeacher: String(oldTeacherId),
          oldTeacherEmail: oldTeacher.googleMeetEmail,
          newTeacher: String(newTeacherId),
          newTeacherEmail: newEmail,
          calendarEventId: session.googleMeet?.calendarEventId,
          calendarUpdated,
          coHostStatus: session.coHostStatus,
        },
      });
    } catch (logErr) {
      console.error("Audit log failed:", logErr.message);
    }

    res.json({
      success: true,
      message: "Teacher replaced successfully",
      data: {
        sessionId: session._id,
        oldTeacher: {
          id: oldTeacherId,
          name: oldTeacher.fullName,
          email: oldTeacher.googleMeetEmail,
        },
        newTeacher: {
          id: newTeacherId,
          name: newTeacher.fullName,
          email: newTeacher.googleMeetEmail,
        },
        meetingPreserved: true,
        meetingLink: session.googleMeet?.meetingLink || session.meetingLink,
        coHostStatus: session.coHostStatus,
        coHostSwapped,
        calendarUpdated,
        previousState,
      },
    });
  } catch (err) {
    console.error("Teacher replacement error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to replace teacher",
    });
  }
});

// ✅ REQUIRED: Default export for ESM import in server.js
export default router;
