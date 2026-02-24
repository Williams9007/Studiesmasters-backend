// utils/sendMessage.js
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Send welcome email to a user
export const sendWelcomeEmail = async (
  userEmail,
  studentName,
  packageName,
  subjects,
  startDate,
  finishDate,
  studyDuration
) => {
  try {
    await resend.emails.send({
      from: "EduConnectt <onboarding@resend.dev>",
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
    });

    console.log(`✅ Welcome email sent to ${userEmail}`);
  } catch (error) {
    console.error("❌ Failed to send welcome email via Resend:", error.message);
    throw error;
  }
};

// ✅ Notify Admin of activity (payments, new registrations, etc.)
export const notifyAdmin = async (subject, message) => {
  try {
    await resend.emails.send({
      from: "EduConnectt Notifications <onboarding@resend.dev>",
      to: process.env.ADMIN_EMAIL, // your admin email
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; line-height: 1.6;">
          <h2>📢 Admin Notification</h2>
          <p>${message}</p>
          <br/>
          <p>💡 Log into your admin dashboard for details.</p>
          <p>— EduConnectt System</p>
        </div>
      `,
    });

    console.log("✅ Admin notification email sent via Resend");
  } catch (error) {
    console.error("❌ Failed to send admin notification via Resend:", error.message);
    throw error;
  }
};
