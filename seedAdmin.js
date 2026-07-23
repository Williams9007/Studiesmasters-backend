// example seed script
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import Admin from "./models/admin.js";

dotenv.config();

const getMongoUri = () => {
  if (process.env.MONGO_URI) return process.env.MONGO_URI;

  const { MONGO_USER, MONGO_PASSWORD, MONGO_HOST, MONGO_DB_NAME } = process.env;
  if (!MONGO_USER || !MONGO_PASSWORD || !MONGO_HOST || !MONGO_DB_NAME) {
    throw new Error(
      "Missing MongoDB configuration. Set MONGO_URI or MONGO_USER, MONGO_PASSWORD, MONGO_HOST, and MONGO_DB_NAME in .env"
    );
  }

  return `mongodb+srv://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(
    MONGO_PASSWORD
  )}@${MONGO_HOST}/${encodeURIComponent(MONGO_DB_NAME)}`;
};

const seedAdmin = async () => {
  await mongoose.connect(getMongoUri());

  const admins = [
    {
      fullName: "Super Admin",
      email: "elgranddios@gmail.com",
      role: "MAIN_ADMIN",
      adminCode: "EDU-ADMIN",
    },
    {
      fullName: "Second Admin",
      email: "Benedictamensahkwei@gmail.com",
      role: "MAIN_ADMIN",
      adminCode: "EDU-ADMIN",
    },
  ];

  const hashedPassword = await bcrypt.hash("Admin@123", 10);

  for (const adminData of admins) {
    const existing = await Admin.findOne({ email: adminData.email });
    if (existing) {
      console.log(`Admin already exists: ${adminData.email}`);
      continue;
    }

    await Admin.create({
      ...adminData,
      password: hashedPassword,
    });
    console.log(`✅ Admin seeded successfully: ${adminData.email}`);
  }

  process.exit(0);
};

seedAdmin();
