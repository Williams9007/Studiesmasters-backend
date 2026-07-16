import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

export const sendWelcomeEmail = async (
  userEmail,
  studentName,
  packageName,
  subjects,
  startDate,
  finishDate,
  studyDuration,
  temporaryPassword
) => {
  try {
    await resend.emails.send({
      from: "StudiesMasters <onboarding@resend.dev>",
      to: userEmail,
      subject: `Welcome to StudiesMasters, ${studentName}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; line-height: 1.6;">
          <p>Dear <strong>${escapeHtml(studentName)}</strong>,</p>
          <p>Welcome to <strong>StudiesMasters</strong>. Your registration for the <strong>${escapeHtml(packageName)}</strong> plan has been received.</p>
          <p><strong>Subjects:</strong> ${escapeHtml(subjects)}<br/>
          <strong>Study period:</strong> ${escapeHtml(startDate)} to ${escapeHtml(finishDate)}<br/>
          <strong>Duration:</strong> ${escapeHtml(studyDuration)}</p>
          <p>Use the details below to sign in:</p>
          <p><strong>Email:</strong> ${escapeHtml(userEmail)}<br/>
          <strong>Temporary password:</strong> <code style="font-size: 16px; font-weight: bold;">${escapeHtml(temporaryPassword)}</code></p>
          <p>Please keep this password private and change it after your first sign-in.</p>
          <p>Kind regards,<br/>The StudiesMasters Team</p>
        </div>
      `,
    });

    console.log(`Welcome email sent to ${userEmail}`);
  } catch (error) {
    console.error("Failed to send welcome email via Resend:", error.message);
    throw error;
  }
};

export const notifyAdmin = async (subject, message) => {
  try {
    await resend.emails.send({
      from: "StudiesMasters Notifications <onboarding@resend.dev>",
      to: process.env.ADMIN_EMAIL,
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; line-height: 1.6;">
          <h2>StudiesMasters Admin Notification</h2>
          <p>${escapeHtml(message)}</p>
          <p>Log into your admin dashboard for details.</p>
          <p>The StudiesMasters Team</p>
        </div>
      `,
    });

    console.log("Admin notification email sent via Resend");
  } catch (error) {
    console.error("Failed to send admin notification via Resend:", error.message);
    throw error;
  }
};
