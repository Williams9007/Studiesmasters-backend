import mongoose from "mongoose";
import dotenv from "dotenv";
import Subject from "./models/Subject.js";
import connectDB from "./config/db.js";

dotenv.config();

const seedSubjects = async () => {
  try {
    await connectDB();
    console.log("✅ MongoDB connected");

    await Subject.deleteMany();
    console.log("🧹 Old subjects cleared");

    const subjects = [
      // ==== GES - EC ====
      ...["Basic 4"].flatMap((grade) => [
        { name: "English", package: "GES-EC", grade, price: 600 },
        { name: "Maths", package: "GES-EC", grade, price: 600 },
        { name: "Science", package: "GES-EC", grade, price: 800 },
      ]),
      ...["Basic 5", "Basic 6"].flatMap((grade) => [
        { name: "English", package: "GES-EC", grade, price: 650 },
        { name: "Maths", package: "GES-EC", grade, price: 650 },
        { name: "Science", package: "GES-EC", grade, price: 800 },
      ]),
      ...["JHS 1", "JHS 2", "JHS 3"].flatMap((grade) => [
        { name: "English", package: "GES-EC", grade, price: 700 },
        { name: "Maths", package: "GES-EC", grade, price: 700 },
        { name: "Science", package: "GES-EC", grade, price: 850 },
      ]),
      ...["SHS 1", "SHS 2", "SHS 3"].flatMap((grade) => [
        { name: "English", package: "GES-EC", grade, price: 750 },
        { name: "Maths", package: "GES-EC", grade, price: 750 },
        { name: "Science", package: "GES-EC", grade, price: 850 },
      ]),

      // ==== GES - WC ====
      ...["Basic 4"].flatMap((grade) => [
        { name: "English", package: "GES-WC", grade, price: 600 },
        { name: "Maths", package: "GES-WC", grade, price: 600 },
        { name: "Science", package: "GES-WC", grade, price: 800 },
      ]),
      ...["Basic 5", "Basic 6"].flatMap((grade) => [
        { name: "English", package: "GES-WC", grade, price: 650 },
        { name: "Maths", package: "GES-WC", grade, price: 650 },
        { name: "Science", package: "GES-WC", grade, price: 800 },
      ]),
      ...["JHS 1", "JHS 2", "JHS 3"].flatMap((grade) => [
        { name: "English", package: "GES-WC", grade, price: 700 },
        { name: "Maths", package: "GES-WC", grade, price: 700 },
        { name: "Science", package: "GES-WC", grade, price: 850 },
      ]),
      ...["SHS 1", "SHS 2", "SHS 3"].flatMap((grade) => [
        { name: "English", package: "GES-WC", grade, price: 750 },
        { name: "Maths", package: "GES-WC", grade, price: 750 },
        { name: "Science", package: "GES-WC", grade, price: 850 },
      ]),

      // ==== GES - OC ====
      ...["Basic 4"].flatMap((grade) => [
        { name: "English", package: "GES-OC", grade, price: 1000 },
        { name: "Maths", package: "GES-OC", grade, price: 1000 },
        { name: "Science", package: "GES-OC", grade, price: 1200 },
      ]),
      ...["Basic 5", "Basic 6"].flatMap((grade) => [
        { name: "English", package: "GES-OC", grade, price: 1100 },
        { name: "Maths", package: "GES-OC", grade, price: 1100 },
        { name: "Science", package: "GES-OC", grade, price: 1300 },
      ]),
      ...["JHS 1", "JHS 2", "JHS 3"].flatMap((grade) => [
        { name: "English", package: "GES-OC", grade, price: 1200 },
        { name: "Maths", package: "GES-OC", grade, price: 1200 },
        { name: "Science", package: "GES-OC", grade, price: 1400 },
      ]),
      ...["SHS 1", "SHS 2", "SHS 3"].flatMap((grade) => [
        { name: "English", package: "GES-OC", grade, price: 1300 },
        { name: "Maths", package: "GES-OC", grade, price: 1300 },
        { name: "Science", package: "GES-OC", grade, price: 1500 },
      ]),

      // ==== GES - EPC ====
      ...["BECE"].flatMap((grade) => [
        { name: "English", package: "GES-EPC", grade, price: 1000 },
        { name: "Maths", package: "GES-EPC", grade, price: 1000 },
        { name: "Science", package: "GES-EPC", grade, price: 1200 },
      ]),
      ...["WASSCE"].flatMap((grade) => [
        { name: "English", package: "GES-EPC", grade, price: 1200 },
        { name: "Maths", package: "GES-EPC", grade, price: 1200 },
        { name: "Science", package: "GES-EPC", grade, price: 1300 },
      ]),
      ...["NOVDEC"].flatMap((grade) => [
        { name: "English", package: "GES-EPC", grade, price: 1200 },
        { name: "Maths", package: "GES-EPC", grade, price: 1200 },
        { name: "Science", package: "GES-EPC", grade, price: 1300 },
      ]),

      // ==== GES - SC ====
      ...["Basic 4"].map((grade) => ({
        name: "English,Maths & Science",
        package: "GES-SC",
        grade,
        price: 1500,
      })),
      ...["Basic 5", "Basic 6"].map((grade) => ({
        name: "English,Maths & Science",
        package: "GES-SC",
        grade,
        price: 2000,
      })),
      ...["JHS 1", "JHS 2", "JHS 3"].map((grade) => ({
        name: "English,Maths & Science",
        package: "GES-SC",
        grade,
        price: 2500,
      })),

      // ==== GES - VC ====
      ...["SHS 1", "SHS 2", "SHS 3"].flatMap((grade) => [
        { name: "English", package: "GES-VC", grade, price: 250 },
        { name: "Maths", package: "GES-VC", grade, price: 250 },
        { name: "Science", package: "GES-VC", grade, price: 300 },
      ]),

      // ==== CAMBRIDGE - EC ====
      ...["Stage 4", "Stage 5", "Stage 6"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-EC", grade, price: 900 },
        { name: "Core Maths", package: "CAMBRIDGE-EC", grade, price: 1000 },
        { name: "Combined Science", package: "CAMBRIDGE-EC", grade, price: 1200 },
      ]),
      ...["Stage 7", "Stage 8", "Stage 9", "Stage 10", "Stage 11"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-EC", grade, price: 950 },
        { name: "Core Maths", package: "CAMBRIDGE-EC", grade, price: 1050 },
        { name: "Combined Science", package: "CAMBRIDGE-EC", grade, price: 1250 },
      ]),
      ...["Stage 12", "Stage 13"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-EC", grade, price: 1000 },
        { name: "Core Maths", package: "CAMBRIDGE-EC", grade, price: 1100 },
        { name: "Combined Science", package: "CAMBRIDGE-EC", grade, price: 1300 },
      ]),

      // ==== CAMBRIDGE - WC ====
      ...["Stage 4", "Stage 5", "Stage 6"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-WC", grade, price: 900 },
        { name: "Core Maths", package: "CAMBRIDGE-WC", grade, price: 1000 },
        { name: "Combined Science", package: "CAMBRIDGE-WC", grade, price: 1200 },
      ]),
      ...["Stage 7", "Stage 8", "Stage 9", "Stage 10", "Stage 11"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-WC", grade, price: 950 },
        { name: "Core Maths", package: "CAMBRIDGE-WC", grade, price: 1050 },
        { name: "Combined Science", package: "CAMBRIDGE-WC", grade, price: 1250 },
      ]),
      ...["Stage 12", "Stage 13"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-WC", grade, price: 1000 },
        { name: "Core Maths", package: "CAMBRIDGE-WC", grade, price: 1100 },
        { name: "Combined Science", package: "CAMBRIDGE-WC", grade, price: 1300 },
      ]),

      // ==== CAMBRIDGE - OC ====
      ...["Stage 4", "Stage 5", "Stage 6"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-OC", grade, price: 1800 },
        { name: "Core Maths", package: "CAMBRIDGE-OC", grade, price: 2000 },
        { name: "Combined Science", package: "CAMBRIDGE-OC", grade, price: 2400 },
      ]),
      ...["Stage 7", "Stage 8", "Stage 9", "Stage 10", "Stage 11"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-OC", grade, price: 1800 },
        { name: "Core Maths", package: "CAMBRIDGE-OC", grade, price: 2000 },
        { name: "Combined Science", package: "CAMBRIDGE-OC", grade, price: 2400 },
      ]),
      ...["Stage 12", "Stage 13"].flatMap((grade) => [
        { name: "English", package: "CAMBRIDGE-OC", grade, price: 1800 },
        { name: "Core Maths", package: "CAMBRIDGE-OC", grade, price: 2000 },
        { name: "Combined Science", package: "CAMBRIDGE-OC", grade, price: 2400 },
      ]),
    ];

    // Every subject starts without a Moodle course id (null). Use the admin
    // dashboard (Subjects tab) to assign each subject its real Moodle course id,
    // which the SSO "Open class" button uses to send students into the right course.
    for (const subject of subjects) {
      subject.moodleCourseId = null;
    }

    await Subject.insertMany(subjects);
    console.log("✅ All subjects seeded successfully");
    process.exit();
  } catch (error) {
    console.error("❌ Error seeding subjects:", error);
    process.exit(1);
  }
};

seedSubjects();
