import nodemailer from "nodemailer";
import dotenv from "dotenv";
import ContactMessage from "../models/ContactMessage.js";

dotenv.config();

export const sendContactMessage = async (req, res) => {
  try {
    const { name, email, message } = req.body;

    // ✅ Save message to MongoDB
    const newMessage = new ContactMessage({ name, email, message });
    await newMessage.save();

    // ✅ Send email to admin
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: 587,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"EduConnectt Contact Form" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: `New Contact Message from ${name}`,
      text: `
        Name: ${name}
        Email: ${email}
        Message: ${message}
      `,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ success: true, message: "Message sent successfully!" });
  } catch (error) {
    console.error("❌ Error sending contact message:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
};

// ✅ For Admin Panel — Get all messages
export const getAllMessages = async (req, res) => {
  try {
    const messages = await ContactMessage.find().sort({ createdAt: -1 });
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch messages" });
  }
};
