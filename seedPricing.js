// backend/seedPricing.js
import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "./Config/db.js";
import Pricing from "./models/Pricing.js";

dotenv.config();
connectDB();

const seedPricing = async () => {
  try {
    console.log("Clearing old pricing...");
    await Pricing.deleteMany();

    const pricingData = [
      // ================= GES =================
      {
        curriculum: "GES",
        packageCode: "SC",
        grade: "Basic 4",
        subjects: [
          { name: "English", price: 500 },
          { name: "Maths", price: 500 },
          { name: "Science", price: 500 },
        ],
      },
      {
        curriculum: "GES",
        packageCode: "SC",
        grade: "Basic 5",
        subjects: [
          { name: "English", price: 500 },
          { name: "Maths", price: 500 },
          { name: "Science", price: 500 },
        ],
      },
      {
        curriculum: "GES",
        packageCode: "EC",
        grade: "JHS 1",
        subjects: [
          { name: "English", price: 600 },
          { name: "Maths", price: 600 },
        ],
      },
      {
        curriculum: "GES",
        packageCode: "EC",
        grade: "JHS 2",
        subjects: [
          { name: "English", price: 600 },
          { name: "Maths", price: 600 },
        ],
      },

      // ================= CAMBRIDGE =================
      {
        curriculum: "CAMBRIDGE",
        packageCode: "SC",
        grade: "Stage 4",
        subjects: [
          { name: "English", price: 900 },
          { name: "Core Maths", price: 1000 },
          { name: "Combined Science", price: 1200 },
        ],
      },
      {
        curriculum: "CAMBRIDGE",
        packageCode: "EC",
        grade: "Stage 5",
        subjects: [
          { name: "English", price: 900 },
          { name: "Core Maths", price: 1000 },
        ],
      },
      // Add more grades/packages as needed
    ];

    await Pricing.insertMany(pricingData);
    console.log("✅ Pricing seeded successfully!");
    process.exit();
  } catch (err) {
    console.error("❌ Error seeding pricing:", err);
    process.exit(1);
  }
};

seedPricing();
