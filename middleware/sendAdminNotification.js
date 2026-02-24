// utils/sendAdminNotification.js
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ Send notification email
export async function sendAdminNotification(subject, message) {
  try {
    const email = await resend.emails.send({
      from: "EduConnect Admin <onboarding@resend.dev>",
      to: process.env.ADMIN_EMAIL, // your admin email
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
          <h2>📢 ${subject}</h2>
          <p>${message}</p>
          <br/>
          <p>– EduConnect System Notification</p>
        </div>
      `,
    });

    console.log("✅ Admin notification sent via Resend");
  } catch (err) {
    console.error("❌ Failed to send admin notification via Resend:", err.message);
  }
}
