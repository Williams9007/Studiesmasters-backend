// utils/sendTimetableEmail.js
//
// Resend emails for the recurring weekly timetable feature:
//   sendTimetableEmail()     - one summary email per published class schedule
//   sendClassReminderEmail() - optional per-session reminder (opt-in)
//
// Both helpers are BEST-EFFORT: they never throw, so a missing/invalid Resend
// key can never break timetable generation or the lifecycle scheduler.
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const getFromAddress = () =>
  process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL || "onboarding@resend.dev";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const emailsEnabled = () => String(process.env.TIMETABLE_EMAILS || "true") !== "false";

const shell = ({ heading, subheading, body, cta, ctaUrl, footerNote }) => `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8;padding:30px 10px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <tr><td style="background:linear-gradient(135deg,#1d4ed8,#2563eb);padding:36px 40px 26px;text-align:center;">
      <h1 style="color:#ffffff;font-size:26px;margin:0 0 6px;font-weight:700;">${heading}</h1>
      <p style="color:#bfdbfe;font-size:15px;margin:0;">${subheading}</p>
    </td></tr>
    <tr><td style="padding:32px 40px 12px;">${body}</td></tr>
    ${cta && ctaUrl ? `<tr><td style="padding:0 40px 30px;" align="center"><a href="${ctaUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;padding:13px 34px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">${cta}</a></td></tr>` : ""}
    <tr><td style="padding:22px 40px 32px;border-top:1px solid #e2e8f0;">
      <p style="font-size:14px;color:#1e293b;margin:0 0 14px;font-weight:600;">Kind regards,<br><span style="color:#1d4ed8;">StudiesMasters Team</span></p>
      <p style="font-size:11px;color:#94a3b8;margin:0;line-height:1.5;">${footerNote || "This is an automated message. Please do not reply directly."}</p>
    </td></tr>
  </table>
</td></tr></table></body></html>`;

const entriesTable = (entries = []) => {
  const th = "padding:12px;background:#dbeafe;font-size:12px;color:#1d4ed8;text-transform:uppercase;letter-spacing:.04em;";
  const rows = entries
    .map(
      (e) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#1e293b;">${escapeHtml(e.date || e.day || "")}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#475569;">${escapeHtml(e.startTime || "")}${e.endTime ? ` &ndash; ${escapeHtml(e.endTime)}` : ""}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;overflow:hidden;margin:0 0 24px;">
    <tr><th align="left" style="${th}">Date</th><th align="left" style="${th}">Time</th></tr>
    ${rows || `<tr><td colspan="2" style="padding:14px;font-size:14px;color:#64748b;">No sessions in this range.</td></tr>`}
  </table>`;
};

/**
 * One email summarising a published weekly timetable / generated term schedule.
 * @returns {Promise<{sent:boolean, skipped?:string, error?:string, id?:string}>}
 */
export async function sendTimetableEmail({
  to,
  name = "",
  role = "student",
  scope = "",
  entries = [],
  rangeStart = "",
  rangeEnd = "",
  dashboardUrl = "",
  intro = "",
} = {}) {
  try {
    if (!emailsEnabled()) return { sent: false, skipped: "TIMETABLE_EMAILS is false" };
    if (!to) return { sent: false, skipped: "no recipient email" };
    if (!process.env.RESEND_API_KEY) return { sent: false, skipped: "RESEND_API_KEY not configured" };

    const audience = role === "teacher" ? "You are scheduled to teach" : "You are scheduled for";
    const range = rangeStart && rangeEnd ? `${rangeStart} to ${rangeEnd}` : "";
    const greeting = name ? `Dear <strong style="color:#1d4ed8;">${escapeHtml(name)}</strong>,` : "Hello,";

    const html = shell({
      heading: role === "teacher" ? "Your Teaching Timetable" : "Your Class Timetable",
      subheading: scope || "Weekly schedule published",
      body: `
        <p style="font-size:15px;color:#1e293b;margin:0 0 16px;line-height:1.6;">${greeting}</p>
        <p style="font-size:15px;color:#475569;margin:0 0 22px;line-height:1.6;">
          ${escapeHtml(intro || `${audience} the following ${entries.length} class${entries.length === 1 ? "" : "es"}${range ? ` between ${range}` : ""}. Each session also appears in your dashboard and in the Moodle calendar.`)}
        </p>
        ${entriesTable(entries)}`,
      cta: "Open your dashboard",
      ctaUrl: dashboardUrl || process.env.FRONTEND_URL || "https://studiesmasters-frontend.onrender.com",
      footerNote: "You are receiving this because a class timetable was published for you. Contact contactus@studiesmasters.com for changes.",
    });

    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: getFromAddress(),
      reply_to: "contactus@studiesmasters.com",
      to,
      subject: `${scope || "Your class timetable"} has been published`,
      html,
    });
    if (error) return { sent: false, error: error.message };
    console.log(`Timetable email sent to ${to}`);
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error(`Timetable email failed for ${to}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Optional per-session reminder email. Opt-in via CLASS_REMINDER_EMAILS=true.
 * @returns {Promise<{sent:boolean, skipped?:string, error?:string}>}
 */
export async function sendClassReminderEmail({
  to,
  name = "",
  subject = "Class",
  grade = "",
  date = "",
  startTime = "",
  minutesLabel = "soon",
} = {}) {
  try {
    if (String(process.env.CLASS_REMINDER_EMAILS || "false") !== "true") {
      return { sent: false, skipped: "CLASS_REMINDER_EMAILS is not true" };
    }
    if (!to || !process.env.RESEND_API_KEY) return { sent: false, skipped: "no recipient or RESEND_API_KEY" };

    const when = date ? new Date(date).toDateString() : "today";
    const html = shell({
      heading: "Class Reminder",
      subheading: `Starting in ${escapeHtml(minutesLabel)}`,
      body: `
        <p style="font-size:15px;color:#1e293b;margin:0 0 16px;line-height:1.6;">Dear <strong style="color:#1d4ed8;">${escapeHtml(name || "Student")}</strong>,</p>
        <p style="font-size:15px;color:#475569;margin:0 0 20px;line-height:1.6;">
          Your <strong>${escapeHtml(subject)}${grade ? ` (${escapeHtml(grade)})` : ""}</strong> class starts in
          <strong>${escapeHtml(minutesLabel)}</strong> &mdash; ${escapeHtml(when)} at ${escapeHtml(startTime)}.
          Join from your dashboard a few minutes early.
        </p>`,
      cta: "Join the class",
      ctaUrl: process.env.FRONTEND_URL || "https://studiesmasters-frontend.onrender.com",
    });

    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: getFromAddress(),
      reply_to: "contactus@studiesmasters.com",
      to,
      subject: `${subject} starts in ${minutesLabel}`,
      html,
    });
    if (error) return { sent: false, error: error.message };
    return { sent: true };
  } catch (err) {
    console.error(`Class reminder email failed for ${to}:`, err.message);
    return { sent: false, error: err.message };
  }
}

export default { sendTimetableEmail, sendClassReminderEmail };