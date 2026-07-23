import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import QaoUser from "../models/QaoUser.js";

dotenv.config();

const buildMongoUri = () => {
  if (process.env.MONGO_URI) {
    return process.env.MONGO_URI;
  }

  const required = ["MONGO_USER", "MONGO_PASSWORD", "MONGO_HOST", "MONGO_DB_NAME"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing MongoDB env variables: ${missing.join(", ")}`);
  }

  return `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@${process.env.MONGO_HOST}/${encodeURIComponent(process.env.MONGO_DB_NAME)}?retryWrites=true&w=majority`;
};

const seedTutorManager = async () => {
  try {
    const uri = buildMongoUri();
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB for tutor manager seeding");

    const email = "tutor.manager@studiesmasters.com";
    const rawPassword = "TutorManager@123";
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const existing = await QaoUser.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      existing.password = hashedPassword;
      existing.name = "Tutor Manager";
      existing.role = "qao";
      await existing.save();
      console.log(`✅ Updated existing Tutor Manager account: ${email}`);
    } else {
      const qaoCount = await QaoUser.countDocuments();
      const userId = `SM-TM-${String(qaoCount + 1).padStart(6, "0")}`;

      await QaoUser.create({
        name: "Tutor Manager",
        email,
        password: hashedPassword,
        userId,
        role: "qao",
      });
      console.log(`✅ Created Tutor Manager account: ${email}`);
    }

    console.log(`📌 Seed credentials:
  email: ${email}
  password: ${rawPassword}`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Tutor manager seed failed:", error);
    process.exit(1);
  }
};

seedTutorManager();
