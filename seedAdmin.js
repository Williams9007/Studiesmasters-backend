// example seed script
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import Admin from "./models/admin.js";

dotenv.config();

const seedAdmin = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const existing = await Admin.findOne({ email: "Benedictamensahkwei@gmail.com" });
  if (existing) {
    console.log("Admin already exists");
    process.exit(0);
  }

  const hashedPassword = await bcrypt.hash("Admin@123", 10);

  await Admin.create({
    fullName: "Super Admin",
    email: "Benedictamensahkwei@gmail.com",
    password: hashedPassword,
    role: "MAIN_ADMIN",
    adminCode: "EDU-ADMIN",
  });

  console.log("✅ Admin seeded successfully");
  process.exit(0);
};

seedAdmin();
