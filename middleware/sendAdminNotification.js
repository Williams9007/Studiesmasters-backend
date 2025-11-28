import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// ✅ Create and export the transporter for Gmail
export const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465, // SSL port for stable Gmail connection
  secure: true, // use true for 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ✅ Verify transporter when server starts
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email Transporter Error:", error);
  } else {
    console.log("✅ Email Transporter Ready to Send Messages");
  }
});

// ✅ Send notification email (exported function)
export async function sendAdminNotification(subject, message) {
  try {
    const mailOptions = {
      from: `"EduConnect Admin" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER, // send to your own admin email
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
          <h2>📢 ${subject}</h2>
          <p>${message}</p>
          <br/>
          <p>– EduConnect System Notification</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Admin notification sent:", info.response);
  } catch (err) {
    console.error("❌ Failed to send admin notification email:", err);
  }
}
