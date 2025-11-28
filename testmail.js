import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

async function testEmail() {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: 465,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.verify();
    console.log("✅ Gmail SMTP ready");

    await transporter.sendMail({
      from: `"EduConnectt Test" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: "SMTP Test",
      text: "This is a test email from EduConnectt backend",
    });

    console.log("✅ Email sent successfully");
  } catch (err) {
    console.error("❌ Failed:", err);
  }
}

testEmail();
