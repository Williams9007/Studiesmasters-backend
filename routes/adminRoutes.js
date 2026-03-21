import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import Admin from "../models/admin.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import QaoUser from "../models/QaoUser.js";
import Broadcast from "../models/Broadcast.js";

import { sendOtpEmail } from "../utils/sendOtpEmail.js";
import { adminAuth } from "../middleware/adminAuth.js";
import Users from "../models/Users.js";
import Payment from "../models/Payment.js";


const router = express.Router();


// ================= SOCKET.IO SETTER =================
let io;
export const setSocketIO = (socketIoInstance) => {
  io = socketIoInstance;
};



// ================= SEED ADMIN =================
router.post("/seed-admin", async (req, res) => {
  try {
    const existing = await Admin.findOne({ email: "elgranddios@gmail.com" });
    if (existing) return res.json({ message: "Admin already exists" });

    const hashedPassword = await bcrypt.hash("Admin@123", 10);

    const admin = await Admin.create({
      fullName: "Super Admin",
      email: "elgranddios@gmail.com",
      password: hashedPassword,
      role: "MAIN_ADMIN",
      adminCode: "EDU-ADMIN",
    });

    res.json({ success: true, message: "Admin seeded", admin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to seed admin" });
  }
});





// ================= LOGIN =================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: "Email & password required" });

    const admin = await Admin.findOne({ email });
    if (!admin) return res.status(401).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch)
      return res.status(401).json({ message: "Invalid credentials" });

    const otp = Math.floor(100000 + Math.random() * 900000);

    admin.otp = otp;
    admin.otpExpires = Date.now() + 5 * 60 * 1000;
    await admin.save();

    await sendOtpEmail(admin.email, otp);

    res.json({
      success: true,
      message: "OTP sent",
      adminId: admin._id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});



// ================= VERIFY OTP =================
router.post("/verify-otp", async (req, res) => {
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



// ================= STUDENT STATS =================
router.get("/students", adminAuth, async (req, res) => {
  try {
    const totalStudents = await Student.countDocuments();
    const activeStudents = await Student.countDocuments({ status: "active" });
    const pendingStudents = await Student.countDocuments({ status: "pending" });

    res.json({
      success: true,
      totalStudents,
      activeStudents,
      pendingStudents,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch student stats" });
  }
});

// GET all students with details
router.get("/students", adminAuth, async (req, res) => {
  try {
    const students = await Student.find()
      .select("_id fullName grade package status") // only needed fields
      .sort({ grade: 1, package: 1, fullName: 1 }); // sort by grade, package, then name

    // Optionally, also return counts
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
      .select("_id fullName grade package") // only what you need
      .sort({ grade: 1, package: 1 }); // sort by grade, then package

    res.json({ success: true, students });
  } catch (err) {
    console.error("❌ Error fetching students for broadcast:", err);
    res.status(500).json({ message: "Failed to fetch students" });
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
router.post("/broadcast", adminAuth, async (req, res) => {
  try {
    const { subject, message, type } = req.body;
    if (!message) return res.status(400).json({ message: "Message required" });

    const broadcast = await Broadcast.create({
      sender: req.admin.id,
      subject,
      message,
      type,
    });

    // Emit to all connected clients (all rooms)
    if (io) io.emit("new-broadcast", broadcast);

    res.json({ success: true, broadcast });
  } catch (err) {
    console.error("❌ Error sending broadcast:", err);
    res.status(500).json({ message: "Failed to send broadcast" });
  }
});

// ================= BROADCAST TO SINGLE STUDENT =================
router.post("/broadcast/student", adminAuth, async (req, res) => {
  try {
    const { studentId, subject, message } = req.body;
    if (!studentId || !message)
      return res.status(400).json({ message: "Student ID and message required" });

    const broadcast = await Broadcast.create({
      sender: req.admin.id,
      type: "single",
      recipients: [studentId],
      recipientModel: "Student",
      subject,
      message,
      recipientsCount: 1,
    });

    // Emit only to that student's socket room
    if (io) io.to(studentId.toString()).emit("new-broadcast", broadcast);
    console.log(`✅ Broadcast sent to student room: ${studentId}`);

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
    const studentIds = students.map((s) => s._id.toString()); // ensure string

    const broadcast = await Broadcast.create({
      sender: req.admin.id,
      type: "students",
      recipients: studentIds,
      recipientModel: "Student",
      subject,
      message,
      recipientsCount: studentIds.length,
    });

    // Emit to all students individually (each joins their own room)
    if (io) {
      studentIds.forEach((id) => {
       io.emit("broadcast:new", message);

      });
      console.log(`✅ Broadcast sent to all students: ${studentIds.length} rooms`);
    }

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

    // Normalize data for frontend
    const formattedUsers = [
      ...students.map(u => ({ ...u.toObject(), role: "student", name: u.fullName })),
      ...teachers.map(u => ({ ...u.toObject(), role: "teacher", name: u.fullName })),
      ...qaos.map(u => ({ ...u.toObject(), role: "qao", name: u.fullName })),
      ...admins.map(u => ({ ...u.toObject(), role: "admin", name: u.fullName, status: "active" })),
    ];

    // Sort newest first
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

    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting user:", err);
    res.status(500).json({ message: "Failed to delete user" });
  }
});

// ================= CREATE USER =================
router.post("/users/create", adminAuth, async (req, res) => {
  try {
    const {
      fullName,
      name,
      email,
      password,
      role,
      phone,
      experience,
      curriculum,
    } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({
        message: "Email, password and role are required",
      });
    }

    const normalizedRole = role.toLowerCase();

    // 🔎 Check duplicate email across ALL collections
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

    const hashedPassword = await bcrypt.hash(password, 10);

    let newUser;

    // ================= ADMIN =================
    if (normalizedRole === "admin") {
      newUser = await Admin.create({
        fullName,
        email,
        password: hashedPassword,
        role: "MINOR_ADMIN", // ✅ must match enum in admin.js
      });
    }

    // ================= TEACHER =================
    else if (normalizedRole === "teacher") {
      if (!phone || !experience || !curriculum) {
        return res.status(400).json({
          message:
            "Teacher requires phone, experience and curriculum",
        });
      }

      newUser = await Teacher.create({
        fullName,
        email,
        password: hashedPassword,
        phone,
        experience,
        curriculum,
        role: "teacher",
        status: "active",
      });
    }

    // ================= QAO =================
   else if (normalizedRole === "qao") {
  newUser = await QaoUser.create({
    name: fullName || name,
    email,
    password: hashedPassword, // now valid
    role: "qao",
  });
}


    else {
      return res.status(400).json({
        message: "Invalid role selected",
      });
    }

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: newUser,
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
      .select("-__v") // remove unnecessary field
      .populate({
        path: "studentId",
        select: "fullName email grade subscriptionExpiry accountStatus",
      })
      .sort({ createdAt: -1 })
      .lean(); // improves performance for read-only data

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
    endDate.setMonth(endDate.getMonth() + 1); // 1 month subscription

    // Update payment
    payment.status = "confirmed";
    payment.subscriptionStart = startDate;
    payment.subscriptionEnd = endDate;
    payment.reviewedBy = req.admin._id; // if adminAuth attaches admin
    await payment.save();

    // Update student using studentId
    const student = await Student.findById(payment.studentId);

    if (student) {
      student.subscriptionStatus = "active";
      student.accountStatus = "active";
      student.subscriptionExpiry = endDate;
      student.status = "active";
      await student.save();
    }

    // 🔔 Notify dashboard
    if (io) {
      io.emit("payment:confirmed", {
        studentName: student?.fullName,
      });
    }

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








export default router;
