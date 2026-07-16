import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Student from "../models/Student.js";

dotenv.config();

const seedStudents = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not defined. Add it to your .env file.");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const password = await bcrypt.hash("password123", 10);
  const students = [
    {
      fullName: "Alice Mensah",
      email: "alice@school.edu",
      phone: "0500000001",
      password,
      curriculum: "GES",
      package: "Basic",
      practice: "Basic Math",
      grade: "10",
    },
    {
      fullName: "Bob Asante",
      email: "bob@school.edu",
      phone: "0500000002",
      password,
      curriculum: "CAMBRIDGE",
      package: "Standard",
      practice: "Science Practice",
      grade: "11",
    },
    {
      fullName: "Charlotte Owusu",
      email: "charlotte@school.edu",
      phone: "0500000003",
      password,
      curriculum: "SAT",
      package: "Premium",
      practice: "SAT Preparation",
      grade: "12",
    },
  ];

  await Promise.all(
    students.map(({ email, ...student }) =>
      Student.updateOne({ email }, { $set: { ...student, email } }, { upsert: true })
    )
  );

  console.log(`Seeded ${students.length} student accounts.`);
  console.log("Student login password: password123");
};

seedStudents()
  .catch((error) => {
    console.error("Student seeding failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
