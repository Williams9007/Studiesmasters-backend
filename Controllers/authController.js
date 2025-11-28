import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import Admin from "../models/admin.js";
import { sendWelcomeEmail, notifyAdmin } from "../utils/sendMessage.js";

// ===========================
// ✅ REGISTER USER
// ===========================
if (role === "student") {
  const {
    fullName,
    email,
    password,
    curriculum,
    grade,
    package: packageName,
    subjects = [], // should be array of Subject ObjectIds
  } = req.body;

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // ✅ Create student with subject references
  const newStudent = await Student.create({
    fullName,
    email,
    password: hashedPassword,
    curriculum,
    grade,
    package: packageName,
    subjectsEnrolled: subjects, // <-- link subject IDs
  });

  try {
    // ✅ Send welcome email
    await sendWelcomeEmail(
      email,
      fullName,
      packageName,
      subjects, // can map to names if you want later
      curriculum
    );

    // ✅ Notify admin
    await notifyAdmin(
      "New Student Registration",
      `Student ${fullName} registered for the ${packageName} package covering subjects: ${subjects.join(", ")}`
    );
  } catch (emailErr) {
    console.error("❌ Email notification failed:", emailErr);
  }

  return res.status(201).json({
    success: true,
    message: "Student registered successfully",
    user: newStudent,
  });
}


// ===========================
// ✅ LOGIN USER
// ===========================
export const loginUser = async (req, res) => {
  try {
    const { email, password, role } = req.body;

    // Find user in the correct collection
    let user;
    if (role === "student") user = await Student.findOne({ email });
    if (role === "teacher") user = await Teacher.findOne({ email });
    if (role === "admin") user = await Admin.findOne({ email });

    if (!user) return res.status(404).json({ message: "User not found" });

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    // Generate JWT
    const token = jwt.sign(
      { id: user._id, role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user,
    });
  } catch (error) {
    console.error("❌ Login error:", error);
    res.status(500).json({ message: "Login failed", error: error.message });
  }
};
