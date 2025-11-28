import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Admin from "../models/admin.js";
import User from "../models/user.js";
import Teacher from "../models/teacher.js";
import Student from "../models/Student.js";
import QaoUser from "../models/QaoUser.js";
import Subject from "../models/Subject.js";
import Payment from "../models/Payment.js";
import Broadcast from "../models/Broadcast.js";
import { verifyAdmin } from "../middleware/verifyAdmin.js";




const router = express.Router();




/* =====================================================
🔹 ADMIN LOGIN
===================================================== */
// admin-login.jsx
import axios from "axios";

const handleLogin = async (e) => {
  e.preventDefault();
  try {
    const response = await axios.post("http://localhost:5000/api/admin/login", {
      email,
      password,
    });

    // ✅ Save token
    localStorage.setItem("adminToken", response.data.token);

    // redirect to dashboard
    window.location.href = "/admin/dashboard";
  } catch (err) {
    console.error("Login error:", err.response?.data || err.message);
  }
};




/* =====================================================
🔹 VERIFY ADMIN TOKEN
===================================================== */
router.get("/verify", verifyAdmin, async (req, res) => {
try {
const admin = await Admin.findById(req.admin._id).select("-password");
if (!admin) return res.status(404).json({ message: "Admin not found" });
res.json({ success: true, admin });
} catch (err) {
res.status(500).json({ message: "Server error during verification" });
}
});




/* =====================================================
🔹 DASHBOARD USERS
===================================================== */
// ✅ Get Admin Dashboard Info (students, teachers, qaos)
router.get("/dashboard", async (req, res) => {
  try {
    const students = await User.find({ role: "student" })
      .populate("enrolledClasses") // if you have class references
      .select("-password");

    const teachers = await Teacher.find({})
      .populate("assignedSubjects")
      .select("-password");

    const qaos = await User.find({ role: "qao" }).select("-password");

    res.json({ students, teachers, qaos });
  } catch (error) {
    console.error("❌ Dashboard fetch failed:", error);
    res.status(500).json({ message: "Failed to fetch dashboard data" });
  }
});




/* =====================================================
🔹 STATS
===================================================== */
router.get("/stats", verifyAdmin, async (req, res) => {
try {
const students = await User.countDocuments({ role: "student" });
const teachers = await Teacher.countDocuments();
const qaos = await User.countDocuments({ role: "qao" });
const subjects = await Subject.countDocuments();
res.json({ students, teachers, qaos, subjects });
} catch (err) {
console.error("Stats fetch error:", err);
res.status(500).json({ message: "Failed to fetch stats" });
}
});




/* =====================================================
🔹 PAYMENTS
===================================================== */
router.get("/payments", verifyAdmin, async (req, res) => {
try {
const payments = await Payment.find()
.populate("studentId", "name email")
.sort({ createdAt: -1 });
res.json(payments);
} catch (err) {
console.error("Payment fetch error:", err);
res.status(500).json({ message: "Failed to fetch payments" });
}
});




router.put("/payments/:id/confirm", verifyAdmin, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    payment.status = "confirmed";
    await payment.save();
    res.json({ success: true, message: "Payment confirmed successfully" });
  } catch (err) {
    console.error("Confirm payment error:", err);
    res.status(500).json({ message: "Failed to confirm payment" });
  }
});





/* =====================================================
🔹 BROADCASTS
===================================================== */
router.get("/broadcasts", verifyAdmin, async (req, res) => {
try {
const broadcasts = await Broadcast.find().sort({ createdAt: -1 });
res.json(broadcasts);
} catch (err) {
res.status(500).json({ message: "Failed to fetch broadcasts" });
}
});




router.post("/broadcasts", verifyAdmin, async (req, res) => {
  try {
    const { subject, message, recipients = [], type } = req.body;
    const broadcast = new Broadcast({
      subjectName: subject || type || "Announcement",
      message,
      recipients,
      type,
      createdBy: req.admin?._id || null,
    });
    await broadcast.save();
    res.status(201).json({ success: true, message: "Broadcast created", broadcast });
  } catch (err) {
    console.error("Broadcast create error:", err);
    res.status(500).json({ message: "Failed to send broadcast" });
  }
});




/* =====================================================
🔹 ASSIGN SUBJECT
===================================================== */
router.post("/assign-subject", verifyAdmin, async (req, res) => {
try {
const { teacherId, subjectId } = req.body;
const teacher = await Teacher.findById(teacherId);
if (!teacher) return res.status(404).json({ message: "Teacher not found" });
teacher.subjects.push(subjectId);
await teacher.save();
res.json({ success: true, message: "Subject assigned successfully" });
} catch (err) {
console.error("Assign subject error:", err);
res.status(500).json({ message: "Failed to assign subject" });
}
});




/* =====================================================
🔹 DELETE USER
===================================================== */
/* =====================================================
🔹 CREATE USER
===================================================== */
router.post("/users", verifyAdmin, async (req, res) => {
  try {
    const { name, email, role, password } = req.body;
    if (!name || !email || !role || !password) return res.status(400).json({ message: "Missing fields" });

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: "User already exists" });

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    const newUser = await User.create({ name, email, role, password: hashed });

    // create role-specific docs
    if (role === "teacher") {
      await Teacher.create({ userId: newUser._id, name, email });
    }
    if (role === "student") {
      await Student.create({ userId: newUser._id, name, email });
    }
    if (role === "qao") {
      await QaoUser.create({ userId: newUser._id, name, email });
    }

    res.status(201).json({ message: "User created", user: newUser });
  } catch (err) {
    console.error("Create user error:", err);
    res.status(500).json({ message: "Failed to create user" });
  }
});

/* =====================================================
🔹 DELETE USER
===================================================== */
router.delete("/users/:id", verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    await user.remove();
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ message: "Failed to delete user" });
  }
});




export default router;
