// utils/sendAdminNotification.js
import { Resend } from "resend";

// ✅ Send notification email to all configured admin emails
export async function sendAdminNotification(subject, message) {
  // Create the client only when a notification is sent. This ensures dotenv has
  // already loaded and prevents a missing optional email key from stopping the app.
  if (!process.env.RESEND_API_KEY) {
    console.warn("Admin email notification skipped: RESEND_API_KEY is not configured.");
    return;
  }

  // Collect all admin emails (ADMIN_EMAIL + ADMIN_EMAIL_2 + any ADMIN_EMAIL_3...)
  const adminEmails = [
    process.env.ADMIN_EMAIL,
    process.env.ADMIN_EMAIL_2,
    process.env.ADMIN_EMAIL_3,
  ].filter(Boolean);

  if (adminEmails.length === 0) {
    console.warn("⚠️ No ADMIN_EMAIL configured — cannot send admin notification");
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  // Escape HTML to prevent injection in the email body
  const escapeHtml = (str = "") =>
    String(str)
      .replace(/&/g, "\u0026amp;")
      .replace(/</g, "\u0026lt;")
      .replace(/>/g, "\u0026gt;")
      .replace(/"/g, "\u0026quot;")
      .replace(/'/g, "\u0026#039;");

  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br/>");

  try {
    const email = await resend.emails.send({
      from: "Studiesmasters Admin <onboarding@resend.dev>",
      to: adminEmails,
      subject: safeSubject,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; max-width: 600px; margin: 0 auto;">
          <div style="background: #1a1a2e; color: #fff; padding: 16px 24px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">📢 ${safeSubject}</h2>
          </div>
          <div style="background: #f9f9f9; border: 1px solid #e0e0e0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; line-height: 1.6; white-space: pre-line;">${safeMessage}</p>
            <br/>
            <hr style="border: none; border-top: 1px solid #e0e0e0;"/>
            <p style="color: #888; font-size: 13px;">
              – Studiesmasters System Notification<br/>
              <span style="font-size: 12px;">Sent at ${new Date().toLocaleString()}</span>
            </p>
          </div>
        </div>
      `,
    });

    console.log(`✅ Admin notification sent via Resend to: ${adminEmails.join(", ")}`);
  } catch (err) {
    console.error("❌ Failed to send admin notification via Resend:", err.message);
  }
}
