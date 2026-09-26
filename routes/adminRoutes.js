import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import Admin from "../models/admin.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import QaoUser from "../models/QaoUser.js";
import Broadcast from "../models/Broadcast.js";
import Subject from "../models/Subject.js";
import AuditLog from "../models/AuditLog.js";

import { sendOtpEmail } from "../utils/sendOtpEmail.js";
import { sendCredentialsEmail } from "../utils/sendCredentialsEmail.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { validate, schemas } from "../middleware/validate.js";
import Users from "../models/Users.js";
import Payment from "../models/Payment.js";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";
import { curriculumCatalog } from "../data/curriculumCatalog.js";
import * as timetableSvc from "../services/timetable.service.js";
import * as classGroupService from "../services/qao/classGroup.service.js";
import * as leaveService from "../services/qao/leave.service.js";
import * as workloadService from "../services/qao/workload.service.js";
import * as schedulingSvc from "../services/qao/scheduling.service.js";


const router = express.Router();

const isDuplicateKeyError = (error) => error?.code === 11000;

const nextSequentialUserId = async (Model, prefix) => {
  const pattern = new RegExp(`^${prefix}-(\\d{6})$`);
  const latestUser = await Model.findOne({ userId: pattern })
    .sort({ userId: -1 })
    .select("userId")
    .lean();
  const lastNumber = Number(latestUser?.userId?.slice(prefix.length + 1)) || 0;

  return `${prefix}-${String(lastNumber + 1).padStart(6, "0")}`;
};

const createUserWithUniqueId = async (Model, prefix, buildUser) => {
  // The unique database index is the final guard. Retrying covers concurrent
  // requests that read the same currently-highest ID.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const userId = await nextSequentialUserId(Model, prefix);
    try {
      return await Model.create(buildUser(userId));
    } catch (error) {
      if (!isDuplicateKeyError(error) || error?.keyPattern?.userId !== 1) throw error;
    }
  }

  const error = new Error("Could not allocate a unique user ID. Please try again.");
  error.statusCode = 409;
  throw error;
};


// ================= SOCKET.IO SETTER =================
let io;
export const setSocketIO = (socketIoInstance) => {
  io = socketIoInstance;
};

// ================= AUDIT LOG HELPER =================
const logAudit = async ({ admin, action, resource, resourceId, details, req, success = true }) => {
  try {
    await AuditLog.create({
      admin: admin?._id || admin?.id || null,
      adminEmail: admin?.email || null,
      action,
      resource,
      resourceId,
      details,
      ip: req?.ip || req?.connection?.remoteAddress || null,
      userAgent: req?.headers?.["user-agent"] || null,
      success,
      method: req?.method,
      path: req?.originalUrl,
    });
  } catch (err) {
    console.error("⚠️ Audit log write failed:", err.message);
  }
};

// ================= SEED ADMINS =================
router.post("/seed-admins", async (req, res) => {
  try {
    const admins = [
      {
        fullName: "Super Admin",
        email: "elgranddios@gmail.com",
        role: "MAIN_ADMIN",
      },
      {
        fullName: "Second Admin",
        email: "Benedictamensahkwei@gmail.com",
        role: "MAIN_ADMIN",
      },
    ];

    for (let adminData of admins) {
      const existing = await Admin.findOne({ email: adminData.email });

      if (!existing) {
        const hashedPassword = await bcrypt.hash("Admin@123", 10);

        await Admin.create({
          ...adminData,
          password: hashedPassword,
          adminCode: "EDU-ADMIN",
        });
      }
    }

    res.json({ success: true, message: "Admins seeded successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to seed admins" });
  }
});

// ================= LOGIN =================
router.post("/login", validate(schemas.adminLogin), async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await Admin.findOne({ email });
    if (!admin) {
      await logAudit({ action: "LOGIN_FAILED", details: { email }, req, success: false });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      await logAudit({ action: "LOGIN_FAILED", details: { email }, req, success: false });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);

    admin.otp = otp;
    admin.otpExpires = Date.now() + 5 * 60 * 1000;
    await admin.save();

    // Send OTP email asynchronously - don't block login if email fails
    sendOtpEmail(admin.email, otp).catch((emailErr) => {
      console.error("⚠️ OTP email failed (login still succeeds):", emailErr.message);
    });

    await logAudit({ admin, action: "LOGIN_OTP_SENT", details: { email }, req });

    res.json({
      success: true,
      message: "OTP sent",
      adminId: admin._id,
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ================= VERIFY OTP =================
router.post("/verify-otp", validate(schemas.verifyOtp), async (req, res) => {
  try {
    const { adminId, otp } = req.body;

    const admin = await Admin.findById(adminId);
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    if (!admin.otp || admin.otpExpires < Date.now())
      return res.status(400).json({ message: "OTP expired" });

    if (admin.otp.toString() !== otp.toString())
      return res.status(400).json({ message: "Invalid OTP" });

    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    admin.otp = null;
    admin.otpExpires = null;
    await admin.save();

    await logAudit({ admin, action: "LOGIN_SUCCESS", details: { email: admin.email }, req });

    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// ─── CLASS RECORDS (attendance + performance, merged) ────────────────────────
/**
 * GET /api/admin/performance (adminAuth)
 * Site-wide class records computed from ClassSession.attendance — which is fed
 * by BOTH the main website AND the Moodle virtual classroom — so this is the
 * merged attendance/performance record for every teacher and student.
 */
router.get("/performance", adminAuth, async (req, res) => {
  try {
    const ClassGroup = (await import("../models/ClassGroup.js")).default;
    const groups = await ClassGroup.find()
      .populate("teacher", "fullName")
      .populate("students", "fullName")
      .lean();
    const sessions = await ClassSession.find({ status: { $in: ["completed", "live"] } })
      .select("classGroup attendance")
      .lean();

    const byGroup = new Map();
    for (const s of sessions) {
      const key = String(s.classGroup?._id || s.classGroup);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(s);
    }

    const teachers = [];
    const students = [];
    for (const g of groups) {
      const groupSessions = byGroup.get(String(g._id)) || [];
      const total = groupSessions.length;
      if (g.teacher) {
        let joins = 0;
        let minutes = 0;
        for (const s of groupSessions) {
          for (const a of s.attendance || []) { joins += 1; minutes += a.duration || 0; }
        }
        teachers.push({
          teacherId: g.teacher._id,
          name: g.teacher.fullName || "Teacher",
          classGroup: g.code,
          subject: g.subject,
          grade: g.grade,
          students: (g.students || []).length,
          completedSessions: total,
          attendanceJoins: joins,
          minutes,
        });
      }
      for (const st of g.students || []) {
        let attended = 0;
        let minutes = 0;
        for (const s of groupSessions) {
          const rec = (s.attendance || []).find((a) => String(a.student) === String(st._id));
          if (rec) { attended += 1; minutes += rec.duration || 0; }
        }
        students.push({
          studentId: st._id,
          name: st.fullName || "Student",
          classGroup: g.code,
          subject: g.subject,
          totalSessions: total,
          attended,
          attendancePct: total ? Math.round((attended / total) * 100) : 0,
          minutes,
        });
      }
    }
    teachers.sort((a, b) => b.completedSessions - a.completedSessions);
    students.sort((a, b) => b.attendancePct - a.attendancePct || a.name.localeCompare(b.name));
    res.json({ success: true, teachers, students });
  } catch (err) {
    console.error("Admin performance error:", err);
    res.status(500).json({ success: false, message: "Failed to load class records" });
  }
});

// ================= DASHBOARD API =================
router.get("/dashboard", adminAuth, async (req, res) => {
  try {
    const totalStudents = await Student.countDocuments();
    const activeStudents = await Student.countDocuments({ status: "active" });
    const pendingStudents = await Student.countDocuments({ status: "pending" });

    const totalTeachers = await Teacher.countDocuments();
    const totalQaos = await QaoUser.countDocuments();
    const totalBroadcasts = await Broadcast.countDocuments();

    const recentBroadcasts = await Broadcast.find()
      .populate("sender", "fullName")
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      success: true,
      stats: {
        totalStudents,
        activeStudents,
        pendingStudents,
        totalTeachers,
        totalQaos,
        totalBroadcasts,
      },
      recentBroadcasts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch dashboard" });
  }
});

// ================= NOTIFICATIONS =================
router.get("/notifications", adminAuth, async (req, res) => {
  try {
    const broadcasts = await Broadcast.find()
      .sort({ createdAt: -1 })
      .limit(10);

    const notifications = broadcasts.map((b) => ({
      _id: b._id,
      message: b.subject || b.message,
      createdAt: b.createdAt,
    }));

    res.json({ success: true, notifications });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
});

// ================= MARK NOTIFICATION AS READ =================
router.post("/notifications/:id/read", adminAuth, async (req, res) => {
  try {
    const broadcast = await Broadcast.findById(req.params.id);
    if (!broadcast) {
      return res.status(404).json({ message: "Notification not found" });
    }
    res.json({ success: true, message: "Notification marked as read" });
  } catch (err) {
    console.error("Error marking notification as read:", err);
    res.status(500).json({ message: "Failed to mark notification as read" });
  }
});

// ================= GET ALL STUDENTS =================
router.get("/students", adminAuth, async (req, res) => {
  try {
    const students = await Student.find()
      .select("_id fullName grade package status")
      .sort({ grade: 1, package: 1, fullName: 1 });

    const totalStudents = students.length;
    const activeStudents = students.filter((s) => s.status === "active").length;
    const pendingStudents = students.filter((s) => s.status === "pending").length;

    res.json({
      success: true,
      students,
      totalStudents,
      activeStudents,
      pendingStudents,
    });
  } catch (err) {
    console.error("❌ Error fetching students:", err);
    res.status(500).json({ message: "Failed to fetch students" });
  }
});

// GET all students with basic info for broadcast
router.get("/students/list", adminAuth, async (req, res) => {
  try {
    const students = await Student.find()
      .select("_id fullName grade package email")
      .sort({ grade: 1, package: 1 });

    res.json({ success: true, students });
  } catch (err) {
    console.error("❌ Error fetching students for broadcast:", err);
    res.status(500).json({ message: "Failed to fetch students" });
  }
});

// GET all teachers with basic info for broadcast
router.get("/teachers/list", adminAuth, async (req, res) => {
  try {
    const teachers = await Teacher.find()
      .select("_id fullName email experience curriculum status createdAt")
      .sort({ fullName: 1 });

    res.json({ success: true, teachers });
  } catch (err) {
    console.error("❌ Error fetching teachers for broadcast:", err);
    res.status(500).json({ message: "Failed to fetch teachers" });
  }
});

// ================= TEACHERS STATS =================
router.get("/teachers", adminAuth, async (req, res) => {
  try {
    const totalTeachers = await Teacher.countDocuments();
    const activeTeachers = await Teacher.countDocuments({ status: "active" });
    const pendingTeachers = await Teacher.countDocuments({ status: "pending" });

    res.json({
      success: true,
      totalTeachers,
      activeTeachers,
      pendingTeachers,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch teachers stats" });
  }
});

// ================= SEND BROADCAST =================
router.post("/broadcast", adminAuth, validate(schemas.broadcast), async (req, res) => {
  try {
    const { subject, message, type } = req.body;
    if (!message) return res.status(400).json({ message: "Message required" });

    const broadcast = await Broadcast.create({
      sender: req.admin.id,
      subject,
      message,
      type,
    });

    if (io) io.emit("new-broadcast", broadcast);

    await logAudit({ admin: req.admin, action: "BROADCAST_SENT", resource: "Broadcast", resourceId: broadcast._id.toString(), details: { subject, type }, req });

    res.json({ success: true, broadcast });
  } catch (err) {
    console.error("❌ Error sending broadcast:", err);
    res.status(500).json({ message: "Failed to send broadcast" });
  }
});

// ================= BROADCAST TO SINGLE STUDENT =================
router.post("/broadcast/student", adminAuth, validate(schemas.broadcastStudent), async (req, res) => {
  try {
    const { studentId, subject, message } = req.body;

    const broadcast = await Broadcast.create({
      sender: req.admin.id,
      type: "single",
      recipients: [studentId],
      recipientModel: "Student",
      subject,
      message,
      recipientsCount: 1,
    });

    if (io) io.to(studentId.toString()).emit("new-broadcast", broadcast);
    console.log(`✅ Broadcast sent to student room: ${studentId}`);

    await logAudit({ admin: req.admin, action: "BROADCAST_TO_STUDENT", resource: "Broadcast", resourceId: broadcast._id.toString(), details: { studentId, subject }, req });

    res.json({ success: true, message: "Broadcast sent to student", broadcast });
  } catch (err) {
    console.error("❌ Error sending broadcast to student:", err);
    res.status(500).json({ success: false, message: "Failed to send broadcast" });
  }
});

// ================= BROADCAST TO ALL STUDENTS =================
router.post("/broadcast/all", adminAuth, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!message) return res.status(400).json({ message: "Message required" });

    const students = await Student.find().select("_id");
    const studentIds = students.map((s) => s._id.toString());

    const broadcast = await Broadcast.create({
      sender: req.admin.id,
      type: "students",
      recipients: studentIds,
      recipientModel: "Student",
      subject,
      message,
      recipientsCount: studentIds.length,
    });

    if (io) {
      studentIds.forEach((id) => {
       io.emit("broadcast:new", message);
      });
      console.log(`✅ Broadcast sent to all students: ${studentIds.length} rooms`);
    }

    await logAudit({ admin: req.admin, action: "BROADCAST_TO_ALL_STUDENTS", resource: "Broadcast", resourceId: broadcast._id.toString(), details: { subject, count: studentIds.length }, req });

    res.json({ success: true, message: "Broadcast sent to all students", broadcast });
  } catch (err) {
    console.error("❌ Error sending broadcast to all students:", err);
    res.status(500).json({ success: false, message: "Failed to send broadcast" });
  }
});

// ================= BROADCAST HISTORY =================
router.get("/broadcasts", adminAuth, async (req, res) => {
  try {
    const broadcasts = await Broadcast.find()
      .populate("sender", "fullName email")
      .sort({ createdAt: -1 });

    res.json({ success: true, broadcasts });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch broadcasts" });
  }
});

// ================= QAO USERS =================
router.get("/qao-users", adminAuth, async (req, res) => {
  try {
    const qaoUsers = await QaoUser.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      qaoUsers,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch QAO users" });
  }
});

// ================= ALL USERS (UNIFIED) =================
router.get("/users", adminAuth, async (req, res) => {
  try {
    const students = await Student.find().select("_id fullName email status createdAt");
    const teachers = await Teacher.find().select("_id fullName email status createdAt");
    const qaos = await QaoUser.find().select("_id fullName email status createdAt");
    const admins = await Admin.find().select("_id fullName email createdAt");

    const formattedUsers = [
      ...students.map(u => ({ ...u.toObject(), role: "student", name: u.fullName })),
      ...teachers.map(u => ({ ...u.toObject(), role: "teacher", name: u.fullName })),
      ...qaos.map(u => ({ ...u.toObject(), role: "qao", name: u.fullName })),
      ...admins.map(u => ({ ...u.toObject(), role: "admin", name: u.fullName, status: "active" })),
    ];

    formattedUsers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, users: formattedUsers });
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// ================= GET SINGLE USER =================
router.get("/users/:id/:role", adminAuth, async (req, res) => {
  try {
    const { id, role } = req.params;

    let user;
    switch (role.toLowerCase()) {
      case "student":
        user = await Student.findById(id);
        break;
      case "teacher":
        user = await Teacher.findById(id);
        break;
      case "qao":
        user = await QaoUser.findById(id);
        break;
      case "admin":
        user = await Admin.findById(id);
        break;
      default:
        return res.status(400).json({ message: "Invalid role" });
    }

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ success: true, user });
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.status(500).json({ message: "Failed to fetch user" });
  }
});

// ================= DELETE USER =================
router.delete("/users/:id/:role", adminAuth, async (req, res) => {
  try {
    const { id, role } = req.params;

    let deleted;
    switch (role.toLowerCase()) {
      case "student":
        deleted = await Student.findByIdAndDelete(id);
        break;
      case "teacher":
        deleted = await Teacher.findByIdAndDelete(id);
        break;
      case "qao":
        deleted = await QaoUser.findByIdAndDelete(id);
        break;
      case "admin":
        deleted = await Admin.findByIdAndDelete(id);
        break;
      default:
        return res.status(400).json({ message: "Invalid role" });
    }

    if (!deleted) return res.status(404).json({ message: "User not found or already deleted" });

    await logAudit({ admin: req.admin, action: "USER_DELETED", resource: role, resourceId: id, details: { role }, req });

    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting user:", err);
    res.status(500).json({ message: "Failed to delete user" });
  }
});

// ================= CREATE USER =================
router.post("/users/create", adminAuth, validate(schemas.createUser), async (req, res) => {
  try {
    const {
      fullName,
      name,
      email,
      password: providedPassword,
      role,
      phone,
      experience,
      curriculum,
    } = req.body;

    const normalizedRole = role.toLowerCase();

    const existingUser =
      (await Admin.findOne({ email })) ||
      (await Teacher.findOne({ email })) ||
      (await QaoUser.findOne({ email })) ||
      (await Student.findOne({ email }));

    if (existingUser) {
      return res.status(400).json({
        message: "User already exists with this email",
      });
    }

    const tmpPassword = providedPassword || crypto.randomBytes(4).toString("hex").toUpperCase() + "@" + Math.floor(100 + Math.random() * 900);
    const hashedPassword = await bcrypt.hash(tmpPassword, 10);

    let newUser;
    let generatedUserId = "";

    if (normalizedRole === "admin") {
      newUser = await Admin.create({
        fullName,
        email,
        password: hashedPassword,
        role: "MINOR_ADMIN",
      });
    } else if (normalizedRole === "teacher") {
      if (!phone || !experience || !curriculum) {
        return res.status(400).json({
          message: "Teacher requires phone, experience and curriculum",
        });
      }

      const catalog = curriculumCatalog[curriculum];
      const subjectDocs = catalog
        ? await Subject.find({ name: { $in: catalog.subjects }, curriculum }).lean()
        : [];

      const subjectIds = (catalog?.subjects || []).map((name) => {
        const found = subjectDocs.find((s) => s.name === name);
        return found ? found._id : null;
      }).filter(Boolean);

      newUser = await createUserWithUniqueId(Teacher, "SM-TUT", (userId) => ({
        fullName,
        email,
        password: hashedPassword,
        userId,
        employeeRole: "tutor",
        phone,
        experience,
        curriculum,
        role: "teacher",
        status: "active",
        subjectsTeaching: subjectIds,
      }));
      generatedUserId = newUser.userId;
    } else if (normalizedRole === "qao" || normalizedRole === "tutor-manager") {
      newUser = await createUserWithUniqueId(QaoUser, "SM-TM", (userId) => ({
        name: fullName || name,
        email,
        password: hashedPassword,
        userId,
        role: "qao",
      }));
      generatedUserId = newUser.userId;
    } else {
      return res.status(400).json({
        message: "Invalid role selected",
      });
    }

    try {
      const displayRole = normalizedRole === "qao" || normalizedRole === "tutor-manager" ? "tutor-manager" : "teacher";
      await sendCredentialsEmail({
        email,
        fullName: fullName || name,
        userId: generatedUserId || newUser.userId || email,
        temporaryPassword: tmpPassword,
        role: displayRole,
      });
    } catch (emailErr) {
      console.warn("⚠️ Credentials email failed, but user was created:", emailErr.message);
    }

    await logAudit({ admin: req.admin, action: "USER_CREATED", resource: normalizedRole, resourceId: newUser._id.toString(), details: { email, role: normalizedRole }, req });

    res.status(201).json({
      success: true,
      message: "User created successfully. Credentials sent via email.",
      user: newUser,
      credentialsSent: true,
    });
  } catch (error) {
    console.error("❌ Error creating user:", error);
    res.status(error.statusCode || (isDuplicateKeyError(error) ? 409 : 500)).json({
      message: isDuplicateKeyError(error)
        ? "A user with that email or user ID already exists. Please try again."
        : error.message || "Server error while creating user",
    });
  }
});

// ================= GET ALL PAYMENTS =================
router.get("/payments", adminAuth, async (req, res) => {
  try {
    const payments = await Payment.find()
      .select("-__v")
      .populate({
        path: "studentId",
        select: "fullName email grade subscriptionExpiry accountStatus",
      })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: payments.length,
      payments,
    });
  } catch (error) {
    console.error("❌ Error fetching payments:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching payments",
    });
  }
});

// ================= CONFIRM PAYMENT =================
router.put("/payments/:id/confirm", adminAuth, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);

    if (!payment)
      return res.status(404).json({ message: "Payment not found" });

    if (payment.status === "confirmed")
      return res.json({ message: "Payment already confirmed" });

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    payment.status = "confirmed";
    payment.subscriptionStart = startDate;
    payment.subscriptionEnd = endDate;
    payment.reviewedBy = req.admin._id;
    await payment.save();

    const student = await Student.findById(payment.studentId);
    if (student) {
      student.subscriptionStatus = "active";
      student.accountStatus = "active";
      student.subscriptionExpiry = endDate;
      student.status = "active";
      await student.save();
    }

    if (io) {
      io.emit("payment:confirmed", {
        studentName: student?.fullName,
      });
    }

    await logAudit({ admin: req.admin, action: "PAYMENT_CONFIRMED", resource: "Payment", resourceId: payment._id.toString(), details: { studentId: payment.studentId?.toString() }, req });

    res.json({
      success: true,
      message: "Payment confirmed & student activated",
    });
  } catch (error) {
    console.error("❌ Error confirming payment:", error);
    res.status(500).json({
      message: "Error confirming payment",
    });
  }
});

// ================= CLASS GROUPS =================
const CLASS_GROUP_SUBJECTS = ["English", "Maths", "Science"];

router.get("/class-groups/options", adminAuth, async (req, res) => {
  try {
    const [students, teachers] = await Promise.all([
      Student.find()
        .select("_id fullName email phone curriculum grade subjectNames subjects subjectsEnrolled")
        .populate("subjectsEnrolled", "name")
        .sort({ curriculum: 1, grade: 1, fullName: 1 })
        .lean(),
      Teacher.find().select("_id fullName email curriculum").sort({ fullName: 1 }),
    ]);
    const formattedStudents = students.map((student) => ({
      ...student,
      subjectNames: student.subjectNames?.length
        ? student.subjectNames
        : student.subjects?.length
          ? student.subjects
          : student.subjectsEnrolled.map((subject) => subject.name).filter(Boolean),
    }));
    res.json({ students: formattedStudents, teachers, subjects: CLASS_GROUP_SUBJECTS });
  } catch (error) {
    console.error("Class group options error:", error);
    res.status(500).json({ message: "Unable to load students and teachers." });
  }
});

router.get("/class-groups", adminAuth, async (req, res) => {
  try {
    const groups = await ClassGroup.find()
      .populate("teacher", "fullName email")
      .populate("students", "fullName email phone grade")
      .sort({ createdAt: -1 });
    res.json({ groups: groups.map((group) => ({ ...group.toObject(), studentCount: group.students.length })) });
  } catch (error) {
    res.status(500).json({ message: "Unable to load class groups." });
  }
});

router.post("/class-groups/generate", adminAuth, validate(schemas.classGroupGenerate), async (req, res) => {
  try {
    const { curriculum, grade, subject, capacity, studentIds, codePrefix } = req.body;
    const size = Number(capacity);

    const students = await Student.find({ _id: { $in: studentIds } }).select("_id");
    if (students.length !== studentIds.length) {
      return res.status(400).json({ message: "One or more selected students could not be found. Refresh the list and try again." });
    }
    const matchedStudentIds = students.map((student) => student._id);
    const alreadyGrouped = await ClassGroup.findOne({
      curriculum,
      grade,
      subject,
      students: { $in: matchedStudentIds },
    }).select("code");
    if (alreadyGrouped) {
      return res.status(400).json({ message: `One or more selected students are already in ${alreadyGrouped.code}.` });
    }
    const existing = await ClassGroup.find({ code: new RegExp(`^${codePrefix}`, "i") }).select("code");
    let sequence = existing.reduce((max, item) => Math.max(max, Number(item.code.match(/(\d+)$/)?.[1] || 0)), 0);
    const groups = [];
    for (let index = 0; index < students.length; index += size) {
      sequence += 1;
      const groupStudents = students.slice(index, index + size).map((student) => student._id);
      groups.push({ code: `${codePrefix}${sequence}`.toUpperCase(), curriculum, grade, subject, capacity: size, students: groupStudents, status: groupStudents.length === size ? "full" : "active" });
    }
    const created = await ClassGroup.insertMany(groups);

    await logAudit({ admin: req.admin, action: "CLASS_GROUPS_GENERATED", resource: "ClassGroup", details: { curriculum, grade, subject, count: created.length }, req });

    res.status(201).json({ message: `${created.length} class group(s) created.`, groups: created });
  } catch (error) {
    console.error("Class group generation error:", error);
    res.status(500).json({ message: "Unable to create class groups." });
  }
});

router.put("/class-groups/:id/teacher", adminAuth, validate(schemas.assignTeacher), async (req, res) => {
  try {
    const teacher = await Teacher.findById(req.body.teacherId);
    if (!teacher) return res.status(404).json({ message: "Teacher not found." });
    const group = await ClassGroup.findByIdAndUpdate(req.params.id, { teacher: teacher._id }, { new: true }).populate("teacher", "fullName email");
    if (!group) return res.status(404).json({ message: "Class group not found." });

    // Push the assignment to Moodle (account + editing-teacher enrolment on the
    // course(s) mapped for this class's subject/curriculum/grade). Without this
    // the newly assigned teacher had course calendar events pushed to a course
    // they were never enrolled in, so their Moodle calendar stayed EMPTY.
    let moodle = null;
    try {
      const { syncClassGroupEnrollment } = await import("../services/moodle/syncTimetable.js");
      moodle = await syncClassGroupEnrollment({ classGroupId: group._id, req });
    } catch (moodleErr) {
      moodle = { synced: false, reason: String(moodleErr?.message || moodleErr).slice(0, 200) };
    }

    await logAudit({ admin: req.admin, action: "CLASS_GROUP_TEACHER_ASSIGNED", resource: "ClassGroup", resourceId: group._id.toString(), details: { teacherId: req.body.teacherId, moodle }, req });

    res.json({ group, moodle });
  } catch (error) {
    res.status(500).json({ message: "Unable to assign the teacher." });
  }
});

// ================= ASSIGN SUBJECT TO TEACHER =================
// Used by the admin "Assign Subject to Teacher" modal on the main website.
// This endpoint was MISSING entirely, so the modal's POST /api/admin/assign-subject
// returned 404 and the subject was never stored — which is why assigned subjects
// never appeared on the main website (teacher dashboard) and never reached Moodle.
//
// It writes to BOTH authoritative places:
//   1. Teacher.subjectsTeaching -> shown on the main website (teacher subjects).
//   2. TeacherAssignment row     -> drives the Moodle course mapping for teachers
//      (services/moodle/syncProfile.js reads it to resolve the teacher's courses).
// Then it refreshes the teacher's Moodle account + enrolments so the assignment is
// visible in Moodle immediately.
router.post("/assign-subject", adminAuth, async (req, res) => {
  try {
    const { teacherId, subjectId } = req.body || {};
    if (!teacherId || !subjectId) {
      return res.status(400).json({ success: false, message: "teacherId and subjectId are required." });
    }

    const [teacher, subject] = await Promise.all([
      Teacher.findById(teacherId).select("fullName name email curriculum subjectsTeaching").lean(),
      Subject.findById(subjectId).select("name curriculum grade package").lean(),
    ]);
    if (!teacher) return res.status(404).json({ success: false, message: "Teacher not found." });
    if (!subject) return res.status(404).json({ success: false, message: "Subject not found." });

    // 1) Main-website source of truth: the teacher's assigned subjects.
    await Teacher.updateOne({ _id: teacherId }, { $addToSet: { subjectsTeaching: subject._id } });

    // 2) Moodle course-resolution source of truth. A TeacherAssignment row needs a
    //    package + grade; fall back to the subject's own values so the unique
    //    index does not block several grades of the same subject.
    const curriculum = subject.curriculum || teacher.curriculum || "";
    try {
      const TeacherAssignment = (await import("../models/TeacherAssignment.js")).default;
      await TeacherAssignment.findOneAndUpdate(
        {
          teacherId,
          curriculum,
          package: subject.package || "N/A",
          grade: subject.grade || "N/A",
          subject: subject.name,
        },
        { $setOnInsert: { assignedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (assignmentErr) {
      // A duplicate-key race must not fail the assignment itself.
      if (assignmentErr?.code !== 11000) throw assignmentErr;
    }

    // 3) Reflect the assignment in Moodle (account + teacher enrolments on the
    //    mapped courses). Best-effort: a Moodle outage never loses the assignment.
    let moodle = null;
    try {
      const { syncProfile } = await import("../services/moodle/syncProfile.js");
      moodle = await syncProfile({ id: teacherId, role: "teacher", enroll: true, req });
    } catch (moodleErr) {
      moodle = { ok: false, error: String(moodleErr?.message || moodleErr).slice(0, 200) };
    }

    const updated = await Teacher.findById(teacherId)
      .select("fullName email curriculum subjectsTeaching")
      .populate("subjectsTeaching", "name curriculum grade package")
      .lean();

    await logAudit({
      admin: req.admin,
      action: "TEACHER_SUBJECT_ASSIGNED",
      resource: "Teacher",
      resourceId: String(teacherId),
      details: { subjectId: String(subject._id), subject: subject.name, curriculum, moodle },
      req,
    });

    return res.json({
      success: true,
      message: `${subject.name} assigned to ${teacher.fullName || teacher.name || "the teacher"}.`,
      teacher: updated,
      subjects: updated?.subjectsTeaching || [],
      moodle,
    });
  } catch (error) {
    console.error("Assign subject error:", error);
    return res.status(500).json({ success: false, message: error.message || "Unable to assign the subject." });
  }
});

// Read model for the main website: every teacher's assigned subjects. Previously
// only /api/teachers/:id/subjects existed and it returned raw ObjectIds instead of
// populated subject documents, so the admin grid and the teacher dashboard both
// rendered blank subject names.
router.get("/assigned-subjects", adminAuth, async (req, res) => {
  try {
    const teachers = await Teacher.find({ employmentStatus: { $ne: "former" } })
      .select("fullName name email userId curriculum employeeRole subjectsTeaching")
      .populate("subjectsTeaching", "name curriculum grade package moodleCourseId")
      .sort({ fullName: 1 })
      .lean();
    const assignments = teachers.map((t) => ({
      teacherId: t._id,
      name: t.fullName || t.name || "Teacher",
      email: t.email,
      userId: t.userId,
      curriculum: t.curriculum,
      employeeRole: t.employeeRole,
      subjects: (t.subjectsTeaching || []).map((s) => ({
        _id: s?._id || null,
        name: s?.name || "",
        grade: s?.grade || "",
        package: s?.package || "",
        moodleCourseId: s?.moodleCourseId ?? null,
      })),
    }));
    res.json({ success: true, assignments });
  } catch (error) {
    console.error("Assigned subjects error:", error);
    res.status(500).json({ success: false, message: "Failed to load assigned subjects." });
  }
});

// Remove a subject from a teacher (keeps the main website and Moodle in step).
router.delete("/assign-subject/:teacherId/:subjectId", adminAuth, async (req, res) => {
  try {
    const { teacherId, subjectId } = req.params;
    await Teacher.updateOne({ _id: teacherId }, { $pull: { subjectsTeaching: subjectId } });

    // Rebuild Moodle course access from what is left, so a removed subject's
    // courses are unenrolled instead of lingering.
    try {
      const TeacherAssignment = (await import("../models/TeacherAssignment.js")).default;
      const remaining = await Teacher.findById(teacherId).select("subjectsTeaching").lean();
      const subjectDocs = await Subject.find({ _id: { $in: remaining?.subjectsTeaching || [] } })
        .select("name curriculum grade package")
        .lean();
      await TeacherAssignment.deleteMany({ teacherId });
      if (subjectDocs.length) {
        await TeacherAssignment.insertMany(
          subjectDocs.map((s) => ({
            teacherId,
            curriculum: s.curriculum || "",
            package: s.package || "N/A",
            grade: s.grade || "N/A",
            subject: s.name,
          })),
          { ordered: false }
        ).catch(() => {});
      }
      const { syncProfile } = await import("../services/moodle/syncProfile.js");
      await syncProfile({ id: teacherId, role: "teacher", enroll: true, req });
    } catch { /* best-effort — the main website already reflects the removal */ }

    await logAudit({ admin: req.admin, action: "TEACHER_SUBJECT_UNASSIGNED", resource: "Teacher", resourceId: String(teacherId), details: { subjectId: String(subjectId) }, req });
    res.json({ success: true, message: "Subject unassigned." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Unable to unassign the subject." });
  }
});

// ================= ADD STUDENTS TO CLASS GROUP =================
router.post("/class-groups/:id/students", adminAuth, validate(schemas.addStudentsToGroup), async (req, res) => {
  try {
    const { studentIds } = req.body;
    const group = await ClassGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ message: "Class group not found." });

    const students = await Student.find({ _id: { $in: studentIds } }).select("_id");
    if (students.length !== studentIds.length) {
      return res.status(400).json({ message: "One or more selected students could not be found. Refresh the list and try again." });
    }

    const matchedStudentIds = students.map((student) => student._id);
    const alreadyGrouped = await ClassGroup.findOne({
      _id: { $ne: group._id },
      curriculum: group.curriculum,
      grade: group.grade,
      subject: group.subject,
      students: { $in: matchedStudentIds },
    }).select("code");
    if (alreadyGrouped) {
      return res.status(400).json({ message: `One or more selected students are already in ${alreadyGrouped.code}.` });
    }

    const currentIds = group.students.map((id) => id.toString());
    const newIds = matchedStudentIds.filter((id) => !currentIds.includes(id.toString()));
    const duplicates = studentIds.length - newIds.length;
    if (newIds.length === 0) {
      return res.status(400).json({ message: "All selected students are already in this group." });
    }

    if (group.students.length + newIds.length > group.capacity) {
      return res.status(400).json({ message: `This group is at capacity (${group.capacity}). Remove a student before adding more.` });
    }

    group.students.push(...newIds);
    if (group.students.length >= group.capacity) group.status = "full";
    else if (group.status === "full") group.status = "active";
    await group.save();

    const populated = await ClassGroup.findById(group._id).populate("teacher", "fullName email").populate("students", "fullName email phone grade");

    // Enrol the newly added students in the class's Moodle course. Without this a
    // student is a member of the class on the main website but NOT in Moodle, so
    // the pushed calendar events (and the Meet links inside them) never appear for
    // them.
    let moodle = null;
    try {
      const { syncClassGroupEnrollment } = await import("../services/moodle/syncTimetable.js");
      moodle = await syncClassGroupEnrollment({ classGroupId: group._id, req });
    } catch (moodleErr) {
      moodle = { synced: false, reason: String(moodleErr?.message || moodleErr).slice(0, 200) };
    }

    await logAudit({ admin: req.admin, action: "CLASS_GROUP_STUDENTS_ADDED", resource: "ClassGroup", resourceId: group._id.toString(), details: { studentIds: newIds.map((id) => id.toString()), added: newIds.length, duplicates: duplicates, moodle }, req });

    res.json({ message: `${newIds.length} student(s) added to ${group.code}.${duplicates ? ` ${duplicates} already existed.` : ""}`, group: populated, moodle });
  } catch (error) {
    console.error("Add students to group error:", error);
    res.status(500).json({ message: "Unable to add students to the group." });
  }
});

// ================= REMOVE STUDENT FROM CLASS GROUP =================
router.delete("/class-groups/:id/students/:studentId", adminAuth, async (req, res) => {
  try {
    const { id, studentId } = req.params;
    const group = await ClassGroup.findById(id);
    if (!group) return res.status(404).json({ message: "Class group not found." });

    const currentIds = group.students.map((sid) => sid.toString());
    if (!currentIds.includes(studentId)) {
      return res.status(400).json({ message: "This student is not in the group." });
    }

    group.students = group.students.filter((sid) => sid.toString() !== studentId);
    if (group.status === "full" && group.students.length < group.capacity) group.status = "active";
    await group.save();

    const populated = await ClassGroup.findById(group._id).populate("teacher", "fullName email").populate("students", "fullName email phone grade");

    await logAudit({ admin: req.admin, action: "CLASS_GROUP_STUDENT_REMOVED", resource: "ClassGroup", resourceId: group._id.toString(), details: { studentId }, req });

    res.json({ message: "Student removed from the group.", group: populated });
  } catch (error) {
    console.error("Remove student from group error:", error);
    res.status(500).json({ message: "Unable to remove the student from the group." });
  }
});

// Admin can reconcile local Paystack payments with Paystack's transaction API.
router.post("/payments/sync-paystack", adminAuth, async (req, res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(400).json({ message: "PAYSTACK_SECRET_KEY is not configured." });
    const response = await fetch("https://api.paystack.co/transaction?perPage=100", { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    const payload = await response.json();
    if (!response.ok || !payload.status) throw new Error(payload.message || "Paystack sync failed.");
    let updated = 0;
    for (const transaction of payload.data || []) {
      if (transaction.status !== "success") continue;
      const payment = await Payment.findOne({ paystackReference: transaction.reference });
      if (payment && payment.status !== "confirmed") {
        payment.status = "confirmed";
        payment.transactionDate = new Date(transaction.paid_at || Date.now());
        await payment.save();
        updated += 1;
      }
    }

    await logAudit({ admin: req.admin, action: "PAYSTACK_SYNC", details: { updated }, req });

    res.json({ message: `Paystack sync complete. ${updated} payment(s) updated.`, updated });
  } catch (error) {
    console.error("Paystack sync error:", error);
    res.status(502).json({ message: error.message || "Unable to sync Paystack payments." });
  }
});

// ================= AUDIT LOG ENDPOINT =================
router.get("/audit-logs", adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.adminId) filter.admin = req.query.adminId;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate("admin", "fullName email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("❌ Error fetching audit logs:", error);
    res.status(500).json({ success: false, message: "Failed to fetch audit logs" });
  }
});

/* ==================== SUBJECTS (moodleCourseId mapping) ==================== */

// List all subjects (for the admin UI that assigns each subject's Moodle course).
router.get("/subjects", adminAuth, async (req, res) => {
  try {
    const subjects = await Subject.find({}).sort({ package: 1, grade: 1, name: 1 });
    res.json({ success: true, subjects });
  } catch (error) {
    console.error("❌ Error fetching subjects:", error);
    res.status(500).json({ success: false, message: "Failed to fetch subjects" });
  }
});

// Assign a subject's Moodle course id (integer) used for SSO redirects.
router.put("/subjects/:id/moodle-course", adminAuth, async (req, res) => {
  try {
    const { moodleCourseId } = req.body;
    const parsed = parseInt(moodleCourseId, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return res.status(400).json({ success: false, message: "moodleCourseId must be a non-negative integer" });
    }
    const subject = await Subject.findByIdAndUpdate(
      req.params.id,
      { moodleCourseId: parsed },
      { new: true }
    );
    if (!subject) return res.status(404).json({ success: false, message: "Subject not found" });
    res.json({ success: true, subject });
  } catch (error) {
    console.error("❌ Error updating subject moodle course:", error);
    res.status(500).json({ success: false, message: "Failed to update subject" });
  }
});

// ================= TIMETABLE MANAGEMENT (Admin dashboard) =================
// Reuses the exact same services as the Tutor Manager so admins can manage the
// recurring weekly timetable for every class (manual day/time slots, teacher
// assignment, daily-schedule generation with Google Calendar + Meet links).

// Bulk push every scheduled timetable session to Moodle's native Calendar
// (idempotent: existing Moodle events are updated, not duplicated). Optional
// filters: { classGroupId, from, to }. Display-sync failures are queued for the
// Moodle worker retry and never break the response.
router.post("/timetable/sync-moodle", adminAuth, async (req, res) => {
  try {
    const { syncClassSession, CLASS_SYNC_ACTIONS } = await import("../services/moodle/index.js");
    const ClassSession = (await import("../models/ClassSession.js")).default;

    const query = { status: { $in: ["scheduled", "live"] } };
    if (req.body?.classGroupId) query.classGroup = req.body.classGroupId;
    if (req.body?.from || req.body?.to) {
      query.date = {};
      if (req.body.from) query.date.$gte = new Date(req.body.from);
      if (req.body.to) query.date.$lte = new Date(req.body.to);
    }

    const sessions = await ClassSession.find(query)
      .populate("classGroup", "code subject grade curriculum")
      .populate("teacher", "fullName")
      .sort({ date: 1, startTime: 1 })
      .lean();

    const results = await Promise.allSettled(
      sessions.map((s) =>
        syncClassSession(s, {
          action: s.meetingStatus === "ready" ? CLASS_SYNC_ACTIONS.MEETING_READY : CLASS_SYNC_ACTIONS.UPDATED,
          sessionId: s._id,
        })
      )
    );

    let synced = 0;
    let queued = 0;
    let failed = 0;
    for (const r of results) {
      const v = r.status === "fulfilled" ? r.value : null;
      if (!v) { failed += 1; continue; }
      if (v.synced) synced += 1;
      else if (v.queued) queued += 1;
      else failed += 1;
    }

    res.json({ success: true, total: sessions.length, synced, queued, failed });
  } catch (err) {
    console.error("Admin timetable Moodle sync error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================= REPAIR: MEET LINKS + MOODLE CALENDAR =================
// One-click repair for the two problems that made scheduled classes look broken
// in Moodle:
//   1. Classes created while Google was not connected were saved with
//      meetingStatus "pending" and NO meetingLink, so their Moodle events said
//      "Meeting link pending" forever. POST here generates the missing links
//      (each regeneration immediately re-pushes to Moodle with the link).
//   2. Any class whose Moodle event drifted (old time, blank subject/teacher,
//      wrong course) is re-pushed in a single pass.
// The response also reports the Google connection state so the admin knows
// whether to connect the Google account before/after running the repair.
router.post("/sessions/backfill-meetings", adminAuth, async (req, res) => {
  try {
    const scheduleSvc = await import("../services/qao/scheduling.service.js");
    const google = await import("../services/google/config.js");
    const googleStatus = { configured: google.isConfiguredReal(), allowMock: google.config.allowMock };

    // Report whether the shareable company Google account is actually connected —
    // without it no real Meet link can be minted (the #1 cause of pending links).
    try {
      const GoogleToken = (await import("../models/GoogleToken.js")).default;
      const svcEmail = "virtualclass@studiesmasters.com";
      const row = await GoogleToken.findOne({ provider: "google", email: svcEmail }).lean();
      googleStatus.account = svcEmail;
      googleStatus.connected = Boolean(row?.encryptedRefreshToken);
    } catch { /* status is informative only */ }

    const backfill = await scheduleSvc.backfillPendingMeetings({
      limit: req.body?.limit || 200,
      from: req.body?.from || null,
      to: req.body?.to || null,
      actor: req.admin?.id || null,
    });

    const moodle = req.body?.resyncMoodle === false
      ? null
      : await scheduleSvc.resyncAllClassSessionsToMoodle({ from: req.body?.from || null, to: req.body?.to || null });

    await logAudit({
      admin: req.admin,
      action: "MEET_LINKS_BACKFILLED",
      resource: "ClassSession",
      details: { backfill, moodle, google: googleStatus },
      req,
    });

    const message = backfill.ready > 0
      ? `${backfill.ready} Google Meet link(s) created and pushed to Moodle.`
      : googleStatus.connected
        ? "No classes were missing a Meet link."
        : `No Meet links could be created — connect ${googleStatus.account || "the company Google account"} in Admin → Google first.`;

    res.json({ success: true, message, google: googleStatus, backfill, moodle });
  } catch (err) {
    console.error("Meet link backfill error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Re-push every scheduled class to Moodle (no Meet generation). Useful after
// changing course mappings or fixing a Moodle token/capability problem.
router.post("/sessions/resync-moodle", adminAuth, async (req, res) => {
  try {
    const { resyncAllClassSessionsToMoodle } = await import("../services/qao/scheduling.service.js");
    const result = await resyncAllClassSessionsToMoodle({ from: req.body?.from || null, to: req.body?.to || null });
    await logAudit({ admin: req.admin, action: "CLASS_SESSIONS_RESYNCED", resource: "ClassSession", details: result, req });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Resync sessions error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Grouped weekly timetable per class (sessions included underneath).
router.get("/timetable", adminAuth, async (req, res) => {
  try {
    const timetable = await timetableSvc.listWeeklyTimetable({
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ success: true, timetable });
  } catch (err) {
    console.error("Admin timetable list error:", err);
    res.status(500).json({ success: false, message: "Failed to load timetable" });
  }
});

// Save a class's weekly slots and/or assign a teacher.
router.patch("/timetable/:id/slots", adminAuth, async (req, res) => {
  try {
    const entry = await timetableSvc.saveWeeklySlots({
      classGroupId: req.params.id,
      slots: req.body?.slots,
      teacher: req.body?.teacher,
    });
    res.json({ success: true, classGroup: entry });
  } catch (err) {
    res.status(err.message === "Class group not found" ? 404 : 400).json({ success: false, message: err.message });
  }
});

// Generate concrete sessions across a term range from the class's weekly slots.
router.post("/timetable/:id/generate", adminAuth, async (req, res) => {
  try {
    const result = await timetableSvc.generateRangeSessions({
      classGroupId: req.params.id,
      startDate: req.body?.startDate,
      endDate: req.body?.endDate,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.message === "Class group not found" ? 404 : 400).json({ success: false, message: err.message });
  }
});

// Manually create a class (with weekly slots + optional teacher) for the admin
// Scheduler screen. Delegates to the shared QAO-safe classGroup service.
router.post("/class-groups", adminAuth, async (req, res) => {
  try {
    const group = await classGroupService.createClassGroup(req.body);
    res.status(201).json({ success: true, classGroup: group });
  } catch (err) {
    res.status(err.message.includes("already exists") ? 409 : 400).json({ success: false, message: err.message });
  }
});

export default router;

// ================= ADMIN SCHEDULING =================
// Admin Scheduling panel: sessions / class-groups / teachers / workload /
// leave / live-ops — all admin-only (adminAuth). Week cap: 40h per rolling
// 7-day window (SCHEDULE_HOURS_PER_WEEK).
const SCHEDULE_HOURS_PER_WEEK = 40;
const SCHEDULE_MINUTES_PER_WEEK = SCHEDULE_HOURS_PER_WEEK * 60;

function sessionMinutes(session) {
  const [sh, sm] = String(session.startTime || "00:00").split(":").map(Number);
  const [eh, em] = String(session.endTime || "00:00").split(":").map(Number);
  return Math.max(0, (eh * 60 + (em || 0)) - (sh * 60 + (sm || 0)));
}

function oid(hex) {
  return new mongoose.Types.ObjectId(hex);
}

// Minimal safe session shape for admin scheduling panels (no student PII).
const SAFE_SESSION_FIELDS = "code curriculum grade subject capacity status schedule weeklySlots meetingLink";
function safeSession(s) {
  const sg = s.classGroup;
  return {
    _id: s._id,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    durationMinutes: s.durationMinutes,
    status: s.status,
    meetingLink: s.meetingLink,
    meetingStatus: s.meetingStatus,
    meetingCode: s.meetingCode,
    classGroup: sg ? { _id: sg._id, code: sg.code, subject: sg.subject, grade: sg.grade } : null,
    teacher: s.teacher
      ? { _id: s.teacher._id, fullName: s.teacher.fullName || s.teacher.name, email: s.teacher.email }
      : null,
    substituteTeacher: s.substituteTeacher
      ? { _id: s.substituteTeacher._id, fullName: s.substituteTeacher.fullName || s.substituteTeacher.name }
      : null,
  };
}

router.get("/scheduling/sessions", adminAuth, async (req, res) => {
  try {
    const sessions = await timetableSvc.listSessions({ from: req.query.from, to: req.query.to, teacherId: req.query.teacher, classGroupId: req.query.group, status: req.query.status });
    res.json({ success: true, sessions });
  } catch (err) {
    console.error("Admin scheduling sessions error:", err);
    res.status(500).json({ success: false, message: "Failed to load sessions" });
  }
});

router.patch("/scheduling/sessions/:id", adminAuth, async (req, res) => {
  try {
    const session = await timetableSvc.updateSession(req.params.id, req.body);
    res.json({ success: true, session });
  } catch (err) {
    console.error("Admin scheduling update error:", err);
    res.status(err.message?.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

router.delete("/scheduling/sessions/:id", adminAuth, async (req, res) => {
  try {
    await timetableSvc.cancelSession(req.params.id);
    res.json({ success: true, message: "Session cancelled" });
  } catch (err) {
    console.error("Admin scheduling cancel error:", err);
    res.status(err.message?.includes("not found") ? 404 : 400).json({ success: false, message: err.message });
  }
});

// Today's live/active sessions for the Live Ops panel.
router.get("/scheduling/today", adminAuth, async (req, res) => {
  try {
    const sessions = await schedulingSvc.todaySessions();
    res.json({ success: true, sessions: sessions.map(safeSession) });
  } catch (err) {
    console.error("Admin scheduling today error:", err);
    res.status(500).json({ success: false, message: "Failed to load today's sessions" });
  }
});

// Class groups for the scheduling panel (with weekly slots exposed).
router.get("/scheduling/class-groups", adminAuth, async (req, res) => {
  try {
    const groups = await ClassGroup.find().populate("teacher", "fullName email employeeRole employmentStatus photo").sort({ createdAt: -1 });
    res.json({ success: true, groups: groups.map((g) => ({ ...g.toObject(), studentCount: g.students?.length || 0, effectiveSlots: effectiveSlots(g), weeklySlots: g.weeklySlots || [] })) });
  } catch (err) {
    console.error("Admin scheduling class-groups error:", err);
    res.status(500).json({ success: false, message: "Failed to load class groups" });
  }
});

// Create a class group from the admin scheduler.
router.post("/scheduling/class-groups", adminAuth, async (req, res) => {
  try {
    const group = await classGroupService.createClassGroup(req.body);
    res.status(201).json({ success: true, classGroup: group });
  } catch (err) {
    res.status(err.message.includes("already exists") ? 409 : 400).json({ success: false, message: err.message });
  }
});

// Update a class group's weekly slots + teacher assignment.
router.patch("/scheduling/class-groups/:id", adminAuth, async (req, res) => {
  try {
    const entry = await timetableSvc.saveWeeklySlots({ classGroupId: req.params.id, slots: req.body?.slots, teacher: req.body?.teacher });
    res.json({ success: true, classGroup: entry });
  } catch (err) {
    res.status(err.message === "Class group not found" ? 404 : 400).json({ success: false, message: err.message });
  }
});

// Teachers list for dropdowns.
router.get("/scheduling/teachers", adminAuth, async (req, res) => {
  try {
    const teachers = await Teacher.find({ employmentStatus: { $ne: "former" } }).select("fullName email employeeRole employmentStatus photo subjectsTeaching").populate("subjectsTeaching", "name").sort({ fullName: 1 }).lean();
    res.json({ success: true, teachers });
  } catch (err) {
    console.error("Admin scheduling teachers error:", err);
    res.status(500).json({ success: false, message: "Failed to load teachers" });
  }
});

// Workload overview (40h cap flag).
router.get("/scheduling/workload", adminAuth, async (req, res) => {
  try {
    const weeks = await workloadService.weeklyHours();
    const teachers = await Teacher.find({ employmentStatus: { $ne: "former" } }).select("fullName email employeeRole employmentStatus photo subjectsTeaching").populate("subjectsTeaching", "name").lean();
    const workload = teachers.map((t) => {
      const h = weeks.get(String(t._id)) || { hours: 0, sessions: 0 };
      const overCap = h.hours > SCHEDULE_HOURS_PER_WEEK;
      return {
        teacherId: t._id,
        name: t.fullName || t.name || "Teacher",
        email: t.email,
        employmentStatus: t.employmentStatus,
        subjects: (t.subjectsTeaching || []).map((s) => s.name),
        hours: h.hours,
        sessions: h.sessions,
        overCap,
        capHours: SCHEDULE_HOURS_PER_WEEK,
        status: h.hours >= 30 ? "overloaded" : h.hours >= 20 ? "heavy" : h.hours >= 10 ? "balanced" : "underloaded",
      };
    });
    res.json({ success: true, workload });
  } catch (err) {
    console.error("Admin scheduling workload error:", err);
    res.status(500).json({ success: false, message: "Failed to load workload" });
  }
});

// Leave requests for admin review.
router.get("/scheduling/leave-requests", adminAuth, async (req, res) => {
  try {
    const LeaveRequest = (await import("../models/LeaveRequest.js")).default;
    const query = {};
    if (req.query.status) query.status = req.query.status;
    const requests = await LeaveRequest.find(query).populate("teacher", "fullName email employeeRole").sort({ createdAt: -1 });
    res.json({ success: true, requests });
  } catch (err) {
    console.error("Admin scheduling leave error:", err);
    res.status(500).json({ success: false, message: "Failed to load leave requests" });
  }
});

// Approve / reject a leave request as admin.
router.patch("/scheduling/leave-requests/:id", adminAuth, async (req, res) => {
  try {
    const LeaveRequest = (await import("../models/LeaveRequest.js")).default;
    const request = await LeaveRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: "Leave request not found" });
    if (["approved", "rejected"].includes(req.body.status)) {
      request.status = req.body.status;
      request.reviewedBy = req.admin?._id || req.admin?.id;
      request.reviewNote = req.body.reviewNote || "";
      await request.save();
    }
    res.json({ success: true, request });
  } catch (err) {
    console.error("Admin scheduling leave review error:", err);
    res.status(500).json({ success: false, message: "Failed to review leave request" });
  }
});

// Live ops stats.
router.get("/scheduling/live-ops", adminAuth, async (req, res) => {
  try {
    const LiveSession = await import("../models/ClassSession.js");
    const ClassSession = LiveSession.default;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);
    const liveSessions = await ClassSession.find({ date: { $gte: todayStart, $lt: todayEnd }, status: "live" })
      .populate("teacher", "fullName email")
      .populate("classGroup", "code subject grade")
      .lean();
    const totalMinutes = liveSessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);
    res.json({ success: true, ops: { liveCount: liveSessions.length, total: liveSessions.length, avgDuration: liveSessions.length ? Math.round(totalMinutes / liveSessions.length) : 0 }, sessions: liveSessions.map(safeSession) });
  } catch (err) {
    console.error("Admin scheduling live-ops error:", err);
    res.status(500).json({ success: false, message: "Failed to load live operations" });
  }
});
