import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const getFromAddress = () => {
  const email = process.env.RESEND_FROM_EMAIL;
  if (!email) throw new Error("RESEND_FROM_EMAIL is missing in your environment variables");
  return email;
};

/**
 * Sends login credentials to a newly created user (Tutor Manager or Teacher).
 */
export const sendCredentialsEmail = async ({
  email,
  fullName,
  userId,
  temporaryPassword,
  role,
}) => {
  const roleLabel = role === "tutor-manager" ? "Tutor Manager" : "Teacher";
  const dashboardLink = role === "tutor-manager"
    ? "https://studiesmasters-frontend.onrender.com/#/qao/access"
    : "https://studiesmasters-frontend.onrender.com/#/teacher/dashboard";

  try {
    const { data, error } = await resend.emails.send({
      from: getFromAddress(),
      reply_to: "contactus@studiesmasters.com",
      to: email,
      subject: `🎉 Congratulations! Your StudiesMasters ${roleLabel} Account is Ready`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f0f4f8; font-family:'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8; padding:30px 10px;">
<tr>
<td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <tr>
      <td style="background:linear-gradient(135deg, #1d4ed8, #2563eb); padding:40px 40px 30px; text-align:center;">
        <h1 style="color:#ffffff; font-size:28px; margin:0 0 8px; font-weight:700;">🎉 Congratulations!</h1>
        <p style="color:#bfdbfe; font-size:16px; margin:0;">Your StudiesMasters ${roleLabel} account has been created</p>
      </td>
    </tr>
    <tr>
      <td style="padding:35px 40px 20px;">
        <p style="font-size:16px; color:#1e293b; margin:0 0 20px; line-height:1.6;">
          Dear <strong style="color:#1d4ed8;">${fullName}</strong>,
        </p>
        <p style="font-size:15px; color:#475569; margin:0 0 25px; line-height:1.6;">
          Welcome to StudiesMasters! We are excited to have you as part of our team. Your ${roleLabel} account has been successfully created. Please use the credentials below to log in to your dashboard.
        </p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff; border-radius:12px; border:1px solid #bfdbfe; margin-bottom:28px;">
          <tr>
            <td style="padding:20px 24px;">
              <h3 style="color:#1d4ed8; font-size:17px; margin:0 0 14px; font-weight:600;">🔑 Your Login Credentials</h3>
              <table width="100%" cellpadding="6" cellspacing="0">
                <tr>
                  <td width="180" style="font-size:14px; color:#64748b; font-weight:600;">User ID:</td>
                  <td style="font-size:15px; color:#1d4ed8; font-weight:700;">${userId}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Email:</td>
                  <td style="font-size:14px; color:#1e293b;">${email}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Temporary Password:</td>
                  <td style="font-size:14px; font-family:monospace; background:#dbeafe; padding:4px 10px; border-radius:4px; display:inline-block; color:#1e293b; font-weight:600;">${temporaryPassword}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:30px;">
          <tr>
            <td align="center">
              <a href="${dashboardLink}" style="display:inline-block; background:#1d4ed8; color:#ffffff; padding:14px 36px; border-radius:8px; text-decoration:none; font-weight:700; font-size:16px;">Login to Dashboard</a>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2; border-radius:10px; border:1px solid #fecaca; margin-bottom:25px;">
          <tr>
            <td style="padding:16px 20px;">
              <p style="font-size:14px; color:#991b1b; margin:0; font-weight:600;">⚠️ Important Security Notice</p>
              <ul style="font-size:13px; color:#991b1b; margin:8px 0 0 18px; padding:0; line-height:1.6;">
                <li>Please change your password after your first login.</li>
                <li>Do not share these credentials with anyone.</li>
                <li>Do not reply to this email.</li>
                <li>Keep this email safe and do not forward it.</li>
              </ul>
            </td>
          </tr>
        </table>

        <p style="font-size:14px; color:#475569; margin:0 0 6px; line-height:1.6;">
          If you have any questions, contact us at <a href="mailto:contactus@studiesmasters.com" style="color:#1d4ed8;">contactus@studiesmasters.com</a>.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:25px 40px 35px; border-top:1px solid #e2e8f0;">
        <p style="font-size:14px; color:#1e293b; margin:0 0 20px; font-weight:600;">Kind regards,<br><span style="color:#1d4ed8;">StudiesMasters Team</span></p>
        <p style="font-size:11px; color:#94a3b8; margin:0; line-height:1.5;">This is an automated message. Please do not reply directly.</p>
      </td>
    </tr>
  </table>
</td>
</tr>
</table>
</body>
</html>`,
    });

    if (error) throw new Error(error.message);
    console.log(`✅ Credentials email sent to ${email} (${roleLabel})`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to send credentials email to ${email}:`, error.message);
    throw error;
  }
};