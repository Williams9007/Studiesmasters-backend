import crypto from "crypto";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const RESET_LINK_TTL_MS = 15 * 60 * 1000;

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
}[character]));

const resend = new Resend(process.env.RESEND_API_KEY);

export const createPasswordResetToken = (account) => {
  const token = crypto.randomBytes(32).toString("hex");
  account.resetToken = crypto.createHash("sha256").update(token).digest("hex");
  account.resetTokenExpiry = new Date(Date.now() + RESET_LINK_TTL_MS);
  return token;
};

export const hashPasswordResetToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

export const sendPasswordResetEmail = async ({ email, name, token, requestType, role }) => {
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  const resetLink = `${frontendUrl}/reset-password/${token}?role=${encodeURIComponent(role)}`;
  const fromEmail = process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL;

  if (!fromEmail) {
    throw new Error("RESEND_FROM_EMAIL or FROM_EMAIL must be set in environment variables.");
  }

  const response = await resend.emails.send({
    from: `StudiesMasters Support <${fromEmail}>`,
    to: email,
    subject: "Reset your StudiesMasters password",
    html: `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Password Reset</title>
      </head>
      <body style="margin:0;padding:0;background-color:#f4f7ff;font-family:Inter,system-ui,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7ff;padding:40px 0;">
          <tr>
            <td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 24px 80px rgba(15,23,42,0.12);">
                <tr>
                  <td style="background:linear-gradient(135deg,#2563eb,#9333ea);padding:40px;text-align:center;color:#ffffff;">
                    <h1 style="margin:0;font-size:32px;line-height:1.1;font-weight:700;">Password reset request</h1>
                    <p style="margin:14px 0 0;font-size:16px;line-height:1.6;color:rgba(255,255,255,0.85);">Reset your StudiesMasters password securely.</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:36px 42px;">
                    <p style="margin:0 0 20px;font-size:16px;line-height:1.75;color:#0f172a;">Hi ${escapeHtml(name || "there")},</p>
                    <p style="margin:0 0 24px;font-size:15px;line-height:1.75;color:#334155;">We received a request to ${escapeHtml(requestType)} for your StudiesMasters account. Click the button below to choose a new password.</p>
                    <div style="text-align:center;margin:32px 0;">
                      <a href="${resetLink}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:16px 28px;font-size:16px;font-weight:700;color:#ffffff;background:#2563eb;border-radius:14px;text-decoration:none;">Reset password</a>
                    </div>
                    <p style="margin:0 0 24px;font-size:15px;line-height:1.75;color:#334155;">If the button above does not work, copy and paste the following link into your browser:</p>
                    <p style="word-break:break-all;margin:0 0 28px;padding:18px;background:#f8fafc;border-radius:14px;border:1px solid #e2e8f0;color:#475569;font-size:14px;">${escapeHtml(resetLink)}</p>
                    <p style="margin:0 0 20px;font-size:15px;line-height:1.75;color:#334155;">This link expires in <strong>15 minutes</strong>. If you did not request a password reset, you can safely ignore this email.</p>
                    <p style="margin:0;font-size:15px;line-height:1.75;color:#475569;">Thank you,<br>The StudiesMasters team</p>
                  </td>
                </tr>
                <tr>
                  <td style="background:#f8fafc;padding:24px 42px;text-align:center;color:#64748b;font-size:13px;line-height:1.6;">
                    <p style="margin:0;">If you need assistance, contact us at <a href="mailto:contactus@studiesmasters.com" style="color:#2563eb;text-decoration:none;">contactus@studiesmasters.com</a>.</p>
                    <p style="margin:14px 0 0;">This email was sent to ${escapeHtml(email)}. © ${new Date().getFullYear()} StudiesMasters.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  });

  console.log(`✅ Password reset email sent to ${email} via Resend`);
  return response;
};
