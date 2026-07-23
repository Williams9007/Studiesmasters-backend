import crypto from "crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";

dotenv.config();

const applyChanges = process.argv.includes("--apply");

const createId = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

const assignMissingIds = async (Model, prefix) => {
  const accounts = await Model.find({
    $or: [{ userId: { $exists: false } }, { userId: null }, { userId: "" }],
  }).select("_id fullName email employeeRole");

  for (const account of accounts) {
    const accountPrefix = prefix === "SM-TUT" && account.employeeRole === "tutor_manager" ? "SM-TM" : prefix;
    const userId = createId(accountPrefix);
    console.log(`${applyChanges ? "Assigned" : "Would assign"} ${userId} to ${account.email}`);
    if (applyChanges) await Model.updateOne({ _id: account._id }, { $set: { userId } });
  }

  return accounts.length;
};

if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");

await mongoose.connect(process.env.MONGO_URI);
try {
  const students = await assignMissingIds(Student, "SM-ST");
  const teachers = await assignMissingIds(Teacher, "SM-TUT");
  console.log(`${applyChanges ? "Updated" : "Found"} ${students} student(s) and ${teachers} employee(s).`);
  if (!applyChanges) console.log("Dry run only. Run with --apply to save the IDs.");
} finally {
  await mongoose.disconnect();
}
