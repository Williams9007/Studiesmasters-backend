import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const getFromAddress = () => {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error("RESEND_FROM_EMAIL is not configured. Use a sender on a Resend-verified domain.");
  }
  return from;
};

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
  temporaryPassword,
  phone,
  curriculum,
  grade,
  preferredDays,
  preferredTime
) => {
  try {
    const { data, error } = await resend.emails.send({
      from: getFromAddress(),
      to: userEmail,
      subject: `Welcome to StudiesMasters, ${studentName}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px; line-height: 1.6;">
          <p>Dear <strong>${escapeHtml(studentName)}</strong>,</p>
          <p>Congratulations on your successful registration with <strong>StudiesMasters</strong>. You have selected the <strong>${escapeHtml(packageName)}</strong> package, covering <strong>${escapeHtml(subjects)}</strong> from <strong>${escapeHtml(startDate)}</strong> to <strong>${escapeHtml(finishDate)}</strong>, for a <strong>${escapeHtml(studyDuration)}</strong> study period.</p>

          <h3 style="margin: 24px 0 8px; color: #1d4ed8;">Your Enrollment Details</h3>
          <p><strong>Student:</strong> ${escapeHtml(studentName)}<br/>
          <strong>Email:</strong> ${escapeHtml(userEmail)}<br/>
          <strong>Phone:</strong> ${escapeHtml(phone)}<br/>
          <strong>Curriculum:</strong> ${escapeHtml(curriculum)}<br/>
          <strong>Grade:</strong> ${escapeHtml(grade)}<br/>
          <strong>Preferred learning days:</strong> ${escapeHtml(preferredDays)}<br/>
          <strong>Preferred learning time:</strong> ${escapeHtml(preferredTime || "To be confirmed")}</p>

          <h3 style="margin: 24px 0 8px; color: #1d4ed8;">Your Sign-in Details</h3>
          <p><strong>Email:</strong> ${escapeHtml(userEmail)}<br/>
          <strong>Generated temporary password:</strong> <code style="font-size: 16px; font-weight: bold;">${escapeHtml(temporaryPassword)}</code></p>
          <p>Please keep this password private and change it after your first sign-in.</p>

          <h3 style="margin: 24px 0 8px; color: #1d4ed8;">Learning Guidelines</h3>
          <ul style="padding-left: 20px;">
            <li>Arrive 10 minutes before your class starts.</li>
            <li>Bring a notepad and writing instrument to every lesson.</li>
            <li>Use your full name when joining online calls for attendance.</li>
            <li>Ensure you have a stable internet connection.</li>
            <li>Mute your microphone while a class is in session unless asked to speak.</li>
            <li>Join lessons from a quiet environment to support concentration.</li>
          </ul>
          <p>Maintaining personal decorum during lesson hours is your responsibility. Failure to do so may result in removal from the class. Cameras are optional; if you choose to turn yours on, please ensure you are dressed appropriately.</p>
          <p><a href="https://studiesmasters-frontend.onrender.com/login" style="color: #1d4ed8; font-weight: bold;">Sign in to access your study schedule, class-joining tutorial, and dashboard.</a></p>
          <p>For questions or support, contact us at <a href="mailto:contactus@studiesmasters.com">contactus@studiesmasters.com</a>.</p>
          <p>Kind regards,<br/>The StudiesMasters Team</p>
          <hr style="border: 0; border-top: 1px solid #ddd; margin: 24px 0;"/>
          <p style="font-size: 12px; color: #666;">This message is confidential. If you received it in error, please reply to inform us and then delete it. Do not copy, forward, or disclose its contents. Email transmission over the Internet cannot be guaranteed to be secure.</p>
        </div>
      `,
    });

    if (error) {
      throw new Error(error.message || "Resend rejected the welcome email.");
    }

    console.log(`Welcome email accepted by Resend for ${userEmail}: ${data?.id}`);
    return data;
  } catch (error) {
    console.error("Failed to send welcome email via Resend:", error.message);
    throw error;
  }
};

export const notifyAdmin = async (subject, message) => {
  try {
    const { data, error } = await resend.emails.send({
      from: getFromAddress(),
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

    if (error) {
      throw new Error(error.message || "Resend rejected the admin notification.");
    }

    console.log(`Admin notification accepted by Resend: ${data?.id}`);
    return data;
  } catch (error) {
    console.error("Failed to send admin notification via Resend:", error.message);
    throw error;
  }
};
