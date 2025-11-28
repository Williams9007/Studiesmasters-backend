import express from "express";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import ContactMessage from "../models/ContactMessage.js";

dotenv.config();
const router = express.Router();

// ✅ Save and send contact message
router.post("/", async (req, res) => {
  try {
    const { name, email, message } = req.body;

    // Save to database
    const newMessage = new ContactMessage({ name, email, message });
    await newMessage.save();

    // Send via email (optional)
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: email,
      to: process.env.EMAIL_USER,
      subject: `New Contact Message from ${name}`,
      text: message,
    });

    res.json({ success: true, message: "Message sent and saved!" });
  } catch (error) {
    console.error("❌ Error sending contact message:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
});

// ✅ Get all contact messages (for admin panel)
router.get("/messages", async (req, res) => {
  try {
    const messages = await ContactMessage.find().sort({ createdAt: -1 });
    res.json({ success: true, messages });
  } catch (error) {
    console.error("❌ Error fetching contact messages:", error);
    res.status(500).json({ success: false, message: "Failed to fetch messages" });
  }
});

export default router;
