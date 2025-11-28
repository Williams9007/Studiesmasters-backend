// utils/sendMessage.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// ✅ Reusable transporter (for both user & admin notifications)
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // STARTTLS (TLS upgrade) used with Gmail
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // App password (not your Gmail password)
  },
  tls: {
    rejectUnauthorized: false, // prevent "unexpected socket close"
  },
});

// ✅ Verify transporter once when server starts
transporter.verify((error, success) => {
  if (error) console.error("❌ Email Transporter Error:", error);
  else console.log("✅ Email transporter ready!");
});

export const sendWelcomeEmail = async (
  userEmail,
  studentName,
  packageName,
  subjects,
  startDate,
  finishDate,
  studyDuration
) => {
  const mailOptions = {
    from: `"EduConnectt" <${process.env.EMAIL_USER}>`,
    to: userEmail,
    subject: `🎉 Welcome to EduConnectt, ${studentName}!`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; line-height: 1.6;">
        <p>Dear <strong>${studentName}</strong>,</p>
        <p>Congratulations on registering for the <strong>${packageName}</strong> package covering 
        <strong>${subjects}</strong> from <strong>${startDate}</strong> to <strong>${finishDate}</strong> 
        (Duration: <strong>${studyDuration}</strong>).</p>
        <p>We’re excited to have you onboard at <strong>EduConnectt</strong> 🎓.</p>
        <br/>
        <p>Kind regards,<br/>The EduConnectt Team</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Welcome email sent to ${userEmail}`);
    return info;
  } catch (error) {
    console.error("❌ Failed to send welcome email:", error);
    throw error;
  }
};

// ✅ NEW: Notify Admin of activity (e.g., payment uploaded, new registration, etc.)
export const notifyAdmin = async (subject, message) => {
  const mailOptions = {
    from: `"EduConnectt Notifications" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_USER, // Admin's email (same as sender)
    subject: subject,
    html: `
      <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; line-height: 1.6;">
        <h2>📢 Admin Notification</h2>
        <p>${message}</p>
        <br/>
        <p>💡 Log into your admin dashboard for details.</p>
        <p>— EduConnectt System</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Admin notification email sent.");
    return info;
  } catch (error) {
    console.error("❌ Failed to send admin notification email:", error);
    throw error;
  }
};
