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
import { curriculumCatalog } from "../data/curriculumCatalog.js";


const router = express.Router();


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

      const teacherCount = await Teacher.countDocuments();
      generatedUserId = `SM-TUT-${String(teacherCount + 1).padStart(6, "0")}`;

      const catalog = curriculumCatalog[curriculum];
      const subjectDocs = catalog
        ? await Subject.find({ name: { $in: catalog.subjects }, curriculum }).lean()
        : [];

      const subjectIds = (catalog?.subjects || []).map((name) => {
        const found = subjectDocs.find((s) => s.name === name);
        return found ? found._id : null;
      }).filter(Boolean);

      newUser = await Teacher.create({
        fullName,
        email,
        password: hashedPassword,
        userId: generatedUserId,
        employeeRole: "tutor",
        phone,
        experience,
        curriculum,
        role: "teacher",
        status: "active",
        subjectsTeaching: subjectIds,
      });
    } else if (normalizedRole === "qao" || normalizedRole === "tutor-manager") {
      const qaoCount = await QaoUser.countDocuments();
      generatedUserId = `SM-TM-${String(qaoCount + 1).padStart(6, "0")}`;

      newUser = await QaoUser.create({
        name: fullName || name,
        email,
        password: hashedPassword,
        userId: generatedUserId,
        role: "qao",
      });
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
    res.status(500).json({
      message: "Server error while creating user",
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

    await logAudit({ admin: req.admin, action: "CLASS_GROUP_TEACHER_ASSIGNED", resource: "ClassGroup", resourceId: group._id.toString(), details: { teacherId: req.body.teacherId }, req });

    res.json({ group });
  } catch (error) {
    res.status(500).json({ message: "Unable to assign the teacher." });
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

export default router;