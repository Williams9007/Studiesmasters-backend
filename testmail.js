import { Resend } from "resend";
import dotenv from "dotenv";
dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

(async () => {
  try {
    const resp = await resend.emails.send({
      from: "EduConnect Admin <onboarding@resend.dev>",
      to: process.env.ADMIN_EMAIL,
      subject: "Test Email",
      html: "<h1>This is a test</h1><p>If you see this, Resend works.</p>",
    });
    console.log("Test email sent:", resp);
  } catch (err) {
    console.error("Test email failed:", err);
  }
})();
