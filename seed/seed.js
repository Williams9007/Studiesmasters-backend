import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User.js";
import Teacher from "../models/teacher.js";
import Subject from "../models/subject.js";
import Payment from "../models/Payment.js";

dotenv.config();
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const seedDB = async () => {
  try {
    // Clear collections
    await User.deleteMany({});
    await Teacher.deleteMany({});
    await Subject.deleteMany({});
    await Payment.deleteMany({});

    // Students
    const students = await User.insertMany([
      { name: "Alice", email: "alice@example.com", role: "student", password: "hashedpassword" },
      { name: "Bob", email: "bob@example.com", role: "student", password: "hashedpassword" },
    ]);

    // Teachers
    const teachers = await Teacher.insertMany([
      { name: "Mr. Smith", email: "smith@example.com", password: "hashedpassword" },
      { name: "Ms. Johnson", email: "johnson@example.com", password: "hashedpassword" },
    ]);

    // Subjects
    const subjects = await Subject.insertMany([
      { name: "Mathematics" },
      { name: "Science" },
    ]);

    // Payments
    const payments = await Payment.insertMany([
      {
        student: students[0]._id,
        amount: 200,
        screenshot: "/uploads/payment1.png",
        createdAt: new Date(),
      },
      {
        student: students[1]._id,
        amount: 150,
        screenshot: "/uploads/payment2.png",
        createdAt: new Date(),
      },
    ]);

    console.log("✅ Database seeded successfully");
    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

seedDB();
