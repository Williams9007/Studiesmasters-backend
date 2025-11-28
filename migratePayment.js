// migratePayments.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Payment from "./models/Payment.js"; // adjust path if needed

dotenv.config();

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// Array of payments to migrate
// Add all your uploaded payment screenshots and their details here
const payments = [
  {
    studentId: "64f8c9d123456789abcdef01", // put the real ObjectId of the student if available
    studentName: "John Doe",
    curriculum: "GES",
    package: "Standard",
    grade: "Basic 4",
    subjects: ["Mathematics", "English"],
    duration: "3months",
    amount: 2000,
    screenshot: "uploads/payments/1759845725545-1006 (1).png",
    referenceName: "JohnD123",
    transactionDate: new Date("2025-11-04"),
    status: "confirmed",
    reviewedBy: null,
  },
  {
    studentId: "64f8c9d123456789abcdef02",
    studentName: "Jane Smith",
    curriculum: "CAMBRIDGE",
    package: "Premium",
    grade: "Basic 5",
    subjects: ["Physics", "Chemistry"],
    duration: "6months",
    amount: 4000,
    screenshot: "uploads/payments/1759845732198-1006 (1).png",
    referenceName: "JaneS456",
    transactionDate: new Date("2025-11-05"),
    status: "pending",
    reviewedBy: null,
  },
  // Add more payment objects here
];

// Function to migrate payments
const migratePayments = async () => {
  try {
    for (const paymentData of payments) {
      // Check if screenshot exists
      const screenshotPath = path.join(paymentData.screenshot);
      if (!fs.existsSync(screenshotPath)) {
        console.warn(`⚠️ Skipping ${paymentData.screenshot}, file not found`);
        continue;
      }

      const payment = new Payment(paymentData);
      await payment.save();
      console.log(`✅ Payment migrated for ${paymentData.studentName}`);
    }
    console.log("🎉 All payments migration completed!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration error:", error);
    process.exit(1);
  }
};

migratePayments();
