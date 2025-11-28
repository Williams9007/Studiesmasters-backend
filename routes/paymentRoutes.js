import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import Payment from "../models/Payment.js";
import ClassEnrollment from "../models/Classenrollment.js";
import Student from "../models/Student.js";
import Package from "../models/package.js";

const router = express.Router();

// ==================== Multer Upload Setup ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});
const upload = multer({ storage });

// ==================== Helper: Calculate Expiry ====================
const calculateExpiry = (startDate, durationStr) => {
  const expiry = new Date(startDate);
  if (!durationStr) return expiry.setDate(expiry.getDate() + 30), expiry;

  const dur = durationStr.toLowerCase();
  if (dur.includes("month")) expiry.setMonth(expiry.getMonth() + parseInt(dur));
  else if (dur.includes("week")) expiry.setDate(expiry.getDate() + parseInt(dur) * 7);
  else if (dur.includes("day")) expiry.setDate(expiry.getDate() + parseInt(dur));
  return expiry;
};

// ==================== Submit Payment ====================
router.post("/submit", upload.single("screenshot"), async (req, res) => {
  try {
    const {
      studentId,
      studentName,
      curriculum,
      package: pkg,
      grade,
      subjects,
      amount,
      referenceName,
      transactionDate,
      duration,
    } = req.body;

    // ✅ Required fields
    if (!studentId || !studentName || !curriculum || !pkg || !grade || !subjects || !amount || !referenceName || !duration) {
      return res.status(400).json({ message: "All required fields must be provided" });
    }

    const subjectsArray = Array.isArray(subjects)
      ? subjects
      : subjects.split(",").map((s) => s.trim());

    const transaction = transactionDate ? new Date(transactionDate) : new Date();
    const expiryDate = calculateExpiry(transaction, duration);

    // ✅ Save Payment
    const payment = await Payment.create({
      studentId: new mongoose.Types.ObjectId(studentId),
      studentName,
      curriculum,
      package: pkg,
      grade,
      subjects: subjectsArray,
      amount,
      referenceName,
      screenshot: req.file?.path || "",
      transactionDate: transaction,
      expiryDate,
      duration,
      status: "pending", // ✅ valid enum
    });

    // ✅ Auto-enroll student into subjects
    const enrollResults = [];
    for (const subject of subjectsArray) {
      const alreadyEnrolled = await ClassEnrollment.findOne({ studentId, curriculum, package: pkg, grade, subject });
      if (alreadyEnrolled) {
        enrollResults.push({ subject, status: "exists" });
        continue;
      }
      await ClassEnrollment.create({ studentId, curriculum, package: pkg, grade, subject });
      enrollResults.push({ subject, status: "enrolled" });
    }

    // ✅ Update Student's payments array
    await Student.findByIdAndUpdate(studentId, { $push: { payments: payment._id } });

    res.status(201).json({
      message: "✅ Payment successful and enrollment processed",
      payment,
      enrollmentSummary: enrollResults,
    });
  } catch (err) {
    console.error("❌ Payment submission error:", err);
    res.status(500).json({ message: "Server error during payment submission", error: err.message });
  }
});

// ==================== Get All Payments ====================
router.get("/", async (req, res) => {
  try {
    const payments = await Payment.find().populate("studentId", "fullName email grade").lean();
    const now = new Date();

    payments.forEach(p => {
      if (p.expiryDate && new Date(p.expiryDate) < now) p.status = "expired";
    });

    res.json(payments);
  } catch (err) {
    console.error("Error fetching payments:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Get All Payments for a Student ====================
router.get("/student/:id", async (req, res) => {
  try {
    const payments = await Payment.find({ studentId: req.params.id }).populate("studentId", "fullName email grade").lean();
    const now = new Date();

    if (!payments || payments.length === 0) return res.json([]);

    const formatted = await Promise.all(payments.map(async (p) => {
      const pkg = await Package.findOne({ name: p.package }).lean();
      const expiryDate = calculateExpiry(p.transactionDate, pkg?.duration || p.duration);
      return {
        studentId: p.studentId._id,
        studentName: p.studentId.fullName,
        studentEmail: p.studentId.email,
        packageName: p.package,
        amount: pkg?.price || p.amount,
        expiryDate: expiryDate.toISOString(),
        expired: now > expiryDate,
        status: now > expiryDate ? "expired" : p.status || "pending",
      };
    }));

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching student payments:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Get Single Payment ====================
router.get("/:id", async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id).populate("studentId", "fullName email grade").lean();
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    const now = new Date();
    if (payment.expiryDate && new Date(payment.expiryDate) < now) payment.status = "expired";

    res.json(payment);
  } catch (err) {
    console.error("Error fetching payment:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Update Payment ====================
router.put("/:id", async (req, res) => {
  try {
    const updated = await Payment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ message: "Payment not found" });
    res.json(updated);
  } catch (err) {
    console.error("Error updating payment:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Delete Payment ====================
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Payment.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Payment not found" });
    res.json({ message: "Payment deleted successfully" });
  } catch (err) {
    console.error("Error deleting payment:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
