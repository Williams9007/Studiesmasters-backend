import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { Resend } from "resend";
import dotenv from "dotenv";

import FreeTrialRequest from "../models/FreeTrialRequest.js";
import { validate } from "../middleware/validate.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { emitToAdmin } from "../services/qao/notify.js";

dotenv.config();
const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

// The marketing form is public and unauthenticated, so it gets its own limiter.
// The global /api limiter allows 200 req / 15 min, which a bored visitor could
// exhaust; this caps lead submissions to 5 per 15 minutes per IP.
const trialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many trial requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const phoneish = /^[0-9+\-\s()]{7,32}$/;

const freeTrialSchema = z.object({
  studentName: z.string().trim().min(1, "Student name is required").max(120),
  grade: z.string().trim().min(1, "Grade is required").max(40),
  subjects: z.array(z.string().trim().max(60)).max(12).default([]),

  parentName: z.string().trim().min(1, "Parent name is required").max(120),
  whatsapp: z
    .string()
    .trim()
    .min(7, "A valid WhatsApp number is required")
    .max(32)
    .regex(phoneish, "Please enter a valid phone number"),
  alternativePhone: z
    .string()
    .trim()
    .max(32)
    .regex(phoneish, "Please enter a valid phone number")
    .or(z.literal(""))
    .default(""),

  preferredDays: z.array(z.string().trim().max(20)).max(3, "Choose up to 3 days only").default([]),
  preferredTime: z.string().trim().max(40).default(""),

  goals: z.array(z.string().trim().max(80)).max(10).default([]),

  consent: z.literal(true, {
    errorMap: () => ({ message: "Please accept the consent before submitting" }),
  }),
});

// ==================== PUBLIC: submit a free trial request
router.post("/", trialLimiter, validate(freeTrialSchema), async (req, res) => {
  try {
    const request = await FreeTrialRequest.create({ ...req.body, source: "website" });

    // Notify the admin room so a live dashboard can show the new lead.
    emitToAdmin("free-trial:new", {
      id: request._id,
      studentName: request.studentName,
      grade: request.grade,
      parentName: request.parentName,
      whatsapp: request.whatsapp,
      createdAt: request.createdAt,
    });

    // Email is best-effort: the lead is already safely stored, so a mail
    // provider outage must not turn a successful submission into a 500.
    try {
      const to = process.env.ADMIN_EMAIL;
      if (resend && to) {
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL,
          to,
          subject: `New free trial request: ${request.studentName} (${request.grade})`,
          html: `
            <div style="font-family:Arial,sans-serif;color:#333;padding:20px">
              <h2>New Free Trial Request</h2>
              <p><strong>Student:</strong> ${request.studentName}</p>
              <p><strong>Grade:</strong> ${request.grade}</p>
              <p><strong>Subjects:</strong> ${request.subjects.join(", ") || "—"}</p>
              <hr />
              <p><strong>Parent:</strong> ${request.parentName}</p>
              <p><strong>WhatsApp:</strong> ${request.whatsapp}</p>
              <p><strong>Alt phone:</strong> ${request.alternativePhone || "—"}</p>
              <p><strong>Preferred days:</strong> ${request.preferredDays.join(", ") || "—"}</p>
              <p><strong>Preferred time:</strong> ${request.preferredTime || "—"}</p>
              <p><strong>Goals:</strong> ${request.goals.join(", ") || "—"}</p>
            </div>`,
        });
      }
    } catch (mailErr) {
      console.warn("⚠️  Free trial saved but admin email failed:", mailErr.message);
    }

    return res.status(201).json({
      success: true,
      message: "Your free trial class request has been received. We will contact you shortly.",
      id: request._id,
    });
  } catch (error) {
    console.error("❌ Error saving free trial request:", error);
    return res.status(500).json({ success: false, message: "Failed to submit request" });
  }
});

// ==================== ADMIN: list requests
router.get("/", adminAuth, async (req, res) => {
  try {
    const { status, limit = 100 } = req.query;

    const filter = {};
    if (status && status !== "all") filter.status = status;

    const requests = await FreeTrialRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 500));

    const counts = await FreeTrialRequest.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    res.json({
      success: true,
      requests,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
    });
  } catch (error) {
    console.error("❌ Error fetching free trial requests:", error);
    res.status(500).json({ success: false, message: "Failed to fetch requests" });
  }
});

// ==================== ADMIN: update status / add a note
router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { status, reviewNote } = req.body;

    const update = { reviewedBy: req.admin?.id || null, reviewedAt: new Date() };
    if (status) update.status = status;
    if (typeof reviewNote === "string") update.reviewNote = reviewNote.trim();

    const request = await FreeTrialRequest.findByIdAndUpdate(req.params.id, update, {
      new: true,
    });

    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    res.json({ success: true, request });
  } catch (error) {
    console.error("❌ Error updating free trial request:", error);
    res.status(500).json({ success: false, message: "Failed to update request" });
  }
});

export default router;