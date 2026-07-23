import dotenv from "dotenv";
dotenv.config();

import { sendWelcomeEmail } from "./message/sendWelcomeEmail.js";

(async () => {
  try {
    console.log("📧 Sending test welcome email...\n");

    const result = await sendWelcomeEmail({
      userEmail: process.env.ADMIN_EMAIL,   // sends to elgranddios@gmail.com
      studentName: "John Doe",
      packageName: "Premium",
      subjects: ["Mathematics", "English", "Science"],
      studyDuration: "12 weeks",
      temporaryPassword: "Temp@12345",
      userId: "SM-ST-000042",
      phone: "+233 55 123 4567",
      curriculum: "GES",
      grade: "Grade 6",
      preferredDays: ["Mondays", "Wednesdays", "Fridays"],
      preferredTime: "Afternoon"
    });

    console.log("✅ Welcome email sent successfully!");
    console.log("📬 Email ID:", result.id);
    console.log("📨 Check your inbox at:", process.env.ADMIN_EMAIL);
  } catch (error) {
    console.error("❌ Failed to send welcome email:", error.message);
  }
})();