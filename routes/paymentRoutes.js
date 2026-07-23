import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import Payment from "../models/Payment.js";
import ClassEnrollment from "../models/ClassEnrollment.js";
import Student from "../models/Student.js";
import Package from "../models/package.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { findPaymentAddOns, findPaymentPlan, paymentAddOns, paymentPlans } from "../data/paymentPlans.js";


const router = express.Router();

// The checkout UI uses this endpoint for renewals and upgrades. Prices are
// defined on the server and are never accepted from the browser as authority.
router.get("/plans/:curriculum", (req, res) => {
  const plans = paymentPlans[req.params.curriculum];
  if (!plans) return res.status(404).json({ message: "No plans found for this curriculum." });
  res.json({ plans, addOns: paymentAddOns[req.params.curriculum] || [] });
});

// ==================== Multer Upload Setup ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error("Invalid file type. Only JPG, PNG, WEBP, and PDF are allowed."), false);
    }
    cb(null, true);
  },
});

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

const enrollStudent = async ({ studentId, curriculum, pkg, grade, subjectsArray }) => {
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
  return enrollResults;
};

const paystackRequest = async (path, options = {}) => {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("Paystack is not configured. Add PAYSTACK_SECRET_KEY to the server environment.");
  }

  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok || !body.status) throw new Error(body.message || "Paystack request failed");
  return body.data;
};

// ==================== Paystack Checkout ====================
router.post("/paystack/initialize", async (req, res) => {
  try {
    // Fail before creating a local pending payment when the server cannot
    // authenticate a checkout request with Paystack.
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        message: "Online payments are not configured. Set PAYSTACK_SECRET_KEY on the server and restart it.",
      });
    }

    const {
      studentId,
      studentName,
      email,
      phone,
      curriculum,
      package: pkg,
      grade = "",
      subjects,
      amount,
      duration = "1 month",
      callbackUrl,
      callback_url: callbackUrlFromBody,
      channels,
      metadata = {},
      paymentMethod,
      paymentPurpose = "new",
      addOns = [],
    } = req.body;
    const subjectsArray = Array.isArray(subjects) ? subjects : String(subjects || "").split(",").map((subject) => subject.trim()).filter(Boolean);
    const plan = findPaymentPlan(curriculum, pkg);
    const selectedAddOns = findPaymentAddOns(curriculum, addOns);
    const selectedCallbackUrl = callbackUrl || callbackUrlFromBody || `${process.env.FRONTEND_URL || "http://localhost:5173"}/payment`;
    const normalizedChannels = Array.isArray(channels) && channels.length
      ? channels
      : paymentMethod === "card"
        ? ["card"]
        : ["mobile_money"];

    if (!studentId || !studentName || !email || !curriculum || !pkg || !plan || !subjectsArray.length) {
      return res.status(400).json({ message: "Complete student, plan, subject, and amount details before paying." });
    }
    if (!["new", "renewal", "upgrade"].includes(paymentPurpose)) {
      return res.status(400).json({ message: "Invalid payment type." });
    }
    if (selectedAddOns.some((addOn) => !addOn)) {
      return res.status(400).json({ message: "One or more selected add-ons are not available for this curriculum." });
    }

    // A renewal is charged at the student's most recent confirmed price.
    // Upgrades are calculated from the server plan and add-on catalogue.
    const previousPayment = paymentPurpose === "renewal"
      ? await Payment.findOne({ studentId, status: "confirmed" }).sort({ transactionDate: -1, createdAt: -1 })
      : null;
    if (paymentPurpose === "renewal" && !previousPayment) {
      return res.status(400).json({ message: "No confirmed payment was found to renew." });
    }
    const selectedPackage = previousPayment?.package || pkg;
    const selectedPlan = previousPayment ? findPaymentPlan(curriculum, selectedPackage) : plan;
    const selectedAddOnNames = previousPayment?.addOns || selectedAddOns.map((addOn) => addOn.name);
    const totalAmount = previousPayment
      ? Number(previousPayment.amount)
      : plan.price + selectedAddOns.reduce((total, addOn) => total + addOn.price, 0);
    const amountInPesewas = Math.round(totalAmount * 100);
    if (!selectedPlan || amountInPesewas <= 0) {
      return res.status(400).json({ message: "The selected payment details are invalid." });
    }

    const reference = `SM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const transaction = new Date();
    const payment = await Payment.create({
      studentId: new mongoose.Types.ObjectId(studentId),
      studentName,
      curriculum,
      package: selectedPackage,
      grade,
      subjects: subjectsArray,
      amount: totalAmount,
      referenceName: reference,
      paystackReference: reference,
      paymentProvider: "paystack",
      transactionDate: transaction,
      duration: selectedPlan.duration,
      status: "pending",
      paymentPurpose,
      addOns: selectedAddOnNames,
    });

    const checkout = await paystackRequest("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: amountInPesewas,
        currency: "GHS",
        reference,
        channels: normalizedChannels,
        callback_url: selectedCallbackUrl,
        label: "Studiesmasters Learning",
        metadata: {
          paymentId: payment._id.toString(),
          studentId,
          phone,
          package: selectedPackage,
          studentName,
          customerName: studentName,
          paymentPurpose,
          addOns: selectedAddOnNames,
          ...metadata,
        },
      }),
    });

    res.status(201).json({
      authorizationUrl: checkout.authorization_url,
      reference,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY || "",
      public_key: process.env.PAYSTACK_PUBLIC_KEY || "",
      amount: totalAmount,
    });
  } catch (err) {
    console.error("Paystack initialization error:", err);
    res.status(500).json({ message: err.message || "Unable to start Paystack checkout." });
  }
});

router.post("/paystack/verify/:reference", async (req, res) => {
  try {
    const { reference } = req.params;
    const payment = await Payment.findOne({ paystackReference: reference });
    if (!payment) return res.status(404).json({ message: "Payment record not found." });
    if (payment.status === "confirmed") return res.json({ message: "Payment already confirmed.", payment });

    const transaction = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
    const expectedAmount = Math.round(Number(payment.amount) * 100);
    if (transaction.status !== "success" || transaction.currency !== "GHS" || transaction.amount !== expectedAmount) {
      return res.status(400).json({ message: "Paystack could not confirm the payment amount." });
    }

    payment.status = "confirmed";
    payment.transactionDate = new Date(transaction.paid_at || Date.now());
    await payment.save();
    const enrollmentSummary = await enrollStudent({
      studentId: payment.studentId,
      curriculum: payment.curriculum,
      pkg: payment.package,
      grade: payment.grade,
      subjectsArray: payment.subjects,
    });
    await Student.findByIdAndUpdate(payment.studentId, {
      $addToSet: { payments: payment._id },
      $set: { package: payment.package, selectedPlan: payment.package },
    });
    res.json({ message: "Payment confirmed and enrollment processed.", payment, enrollmentSummary });
  } catch (err) {
    console.error("Paystack verification error:", err);
    res.status(500).json({ message: err.message || "Unable to verify Paystack payment." });
  }
});

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
    const enrollResults = await enrollStudent({ studentId, curriculum, pkg, grade, subjectsArray });

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


// ==================== ADMIN: GET PAYMENT HISTORY ====================
router.get("/admin/history", adminAuth, async (req, res) => {
  try {
    const payments = await Payment.find()
      .populate("studentId", "fullName email grade")
      .sort({ createdAt: -1 });

    const totalAmount = payments.reduce(
      (sum, p) => sum + Number(p.amount || 0),
      0
    );

    res.json({
      success: true,
      currency: "GHS",
      totalAmount,
      payments,
    });
  } catch (err) {
    console.error("Fetch payment history error:", err);
    res.status(500).json({ message: "Failed to fetch payment history" });
  }
});

export default router;
