// Controllers/contactController.js
import { Resend } from "resend";
import dotenv from "dotenv";
import ContactMessage from "../models/ContactMessage.js";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendContactMessage = async (req, res) => {
  try {
    const { name, email, message } = req.body;

    // ✅ Save message to MongoDB
    const newMessage = new ContactMessage({ name, email, message });
    await newMessage.save();

    // ✅ Send email to admin via Resend
    try {
      await resend.emails.send({
        from: "EduConnect Contact Form <onboarding@resend.dev>",
        to: process.env.ADMIN_EMAIL, // your admin email
        subject: `New Contact Message from ${name}`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
            <h2>New Contact Message</h2>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Message:</strong></p>
            <p>${message}</p>
          </div>
        `,
      });

      console.log(`✅ Contact email sent to admin (${process.env.ADMIN_EMAIL})`);
    } catch (err) {
      console.error("❌ Failed to send contact email via Resend:", err.message);
    }

    res.status(200).json({ success: true, message: "Message saved and email sent!" });
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
    console.error("❌ Failed to fetch messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
};
