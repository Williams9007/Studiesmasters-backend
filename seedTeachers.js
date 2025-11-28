import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import Teacher from "./models/teacher.js"; // update if needed

const MONGO_URI =
  "mongodb+srv://willimensah:242242@cluster0.lbihmuj.mongodb.net/EduConnectt";

const seedTeachers = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected!");

    const passwordGES = await bcrypt.hash("password123", 10);
    const passwordCAMB = await bcrypt.hash("password123", 10);

    const teachers = [
      {
        fullName: "GES Teacher",
        email: "ges@school.com",
        phone: "0500000001",
        password: passwordGES,
        curriculum: "GES",
        subjectsTeaching: [],
        assignmentsGiven: [],
        lessonNotes: [],
        experience: "3 years teaching experience",
      },
      {
        fullName: "Cambridge Teacher",
        email: "cambridge@school.com",
        phone: "0500000002",
        password: passwordCAMB,
        curriculum: "CAMBRIDGE",
        subjectsTeaching: [],
        assignmentsGiven: [],
        lessonNotes: [],
        experience: "4 years teaching experience",
      },
    ];

    await Teacher.deleteMany({});
    console.log("Old teacher accounts removed.");

    await Teacher.insertMany(teachers);
    console.log("Teacher accounts seeded successfully!");

    process.exit();
  } catch (error) {
    console.log("Seeding error:", error);
    process.exit(1);
  }
};

seedTeachers();
