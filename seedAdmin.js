// backend/seedAdmin.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import Admin from "./models/admin.js";

dotenv.config();

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const hashedPassword = await bcrypt.hash("admin123", 10);

    // Clear existing admins to prevent duplicates
    await Admin.deleteMany({});

    await Admin.create({
      fullName: "Super Admin",
      email: "admin@educonnect.com",
      password: hashedPassword,
      role: "Admin",
      adminCode: "EDU-ADMIN-001", // ✅ Required field
    });

    console.log("✅ Admin account created successfully!");
    console.log("📧 Email: admin@educonnect.com");
    console.log("🔑 Password: admin123");
    console.log("🪪 Admin Code: EDU-ADMIN-001");

    process.exit();
  } catch (err) {
    console.error("❌ Error seeding admin:", err);
    process.exit(1);
  }
};

seedAdmin();
