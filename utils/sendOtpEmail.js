// utils/sendOtpEmail.js
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendOtpEmail = async (to, otp) => {
  try {
    const response = await resend.emails.send({
      from: `EduConnect Admin <${process.env.FROM_EMAIL}>`,
      to,                 // OTP recipient (elgranddios@gmail.com)
      subject: "Your Admin OTP Code",
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
          <h2>Admin OTP</h2>
          <p>Your OTP code is:</p>
          <h1>${otp}</h1>
          <p>This code expires in 5 minutes.</p>
        </div>
      `,
    });

    console.log("✅ OTP email sent via Resend:", response);
    return response;
  } catch (error) {
    console.error("❌ Failed to send OTP email:", error);
    throw error;
  }
};
