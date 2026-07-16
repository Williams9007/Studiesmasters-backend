// resetAdminPassword.js
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import Admin from "./models/admin.js";

dotenv.config();

const resetPassword = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const admin = await Admin.findOne({ email: "Benedictamensahkwei@gmail.com" });
  if (!admin) {
    console.log("Admin not found");
    process.exit(0);
  }

  const hashedPassword = await bcrypt.hash("Admin@123", 10);
  admin.password = hashedPassword;
  await admin.save();

  console.log("✅ Password reset successfully");
  process.exit(0);
};

resetPassword();
