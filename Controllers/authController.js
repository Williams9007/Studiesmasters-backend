import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import Admin from "../models/admin.js";
import { sendWelcomeEmail, notifyAdmin } from "../message/sendWelcomeEmail.js";
import { curriculumCatalog } from "../data/curriculumCatalog.js";
import Subject from "../models/Subject.js";

// ===========================
// ✅ REGISTER USER
// ===========================
export const registerUser = async (req, res) => {
  try {
    const { role } = req.body;

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

      if (!fullName || !email || !password || !curriculum || !grade || !packageName) {
        return res.status(400).json({ message: "All required fields must be provided" });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // ✅ Generate StudiesMasters student ID
      const studentCount = await Student.countDocuments();
      const generatedUserId = `SM-ST-${String(studentCount + 1).padStart(6, "0")}`;

      // ✅ Auto-assign subjects based on curriculum
      const catalog = curriculumCatalog[curriculum];
      const subjectDocs = catalog
        ? await Subject.find({ name: { $in: catalog.subjects }, curriculum }).lean()
        : [];

      const subjectIds = (catalog?.subjects || []).map((name) => {
        const found = subjectDocs.find((s) => s.name === name);
        return found ? found._id : null;
      }).filter(Boolean);

      // ✅ Create student
      const newStudent = await Student.create({
        fullName,
        userId: generatedUserId,
        email,
        phone: req.body.phone,
        password: hashedPassword,
        curriculum,
        grade,
        package: packageName,
        subjectsEnrolled: subjectIds.length > 0 ? subjectIds : subjects,
        preferredDays: req.body.preferredDays || [],
        preferredTime: req.body.preferredTime || "",
        studyDuration: req.body.studyDuration || "",
        startDate: req.body.startDate || null,
        finishDate: req.body.finishDate || null,
      });

      // ✅ Send welcome email (non-blocking)
      sendWelcomeEmail({
        userEmail: newStudent.email,
        studentName: newStudent.fullName,
        packageName: newStudent.package,
        subjects: newStudent.subjectNames,
        studyDuration: newStudent.studyDuration,
        temporaryPassword: password,
        userId: newStudent.userId,
        phone: newStudent.phone,
        curriculum: newStudent.curriculum,
        grade: newStudent.grade,
        preferredDays: newStudent.preferredDays,
        preferredTime: newStudent.preferredTime,
      }).catch((emailErr) => {
        console.error("❌ Welcome email failed:", emailErr.message);
      });

      // ✅ Notify admin (non-blocking)
      notifyAdmin(
        "New Student Registration",
        `Student ${fullName} registered for the ${packageName} package covering subjects: ${subjects.join(", ")}`
      ).catch((notifyErr) => {
        console.error("❌ Admin notification failed:", notifyErr.message);
      });

      return res.status(201).json({
        success: true,
        message: "Student registered successfully",
        user: newStudent,
      });
    }

    // Non-student roles are not handled here
    return res.status(400).json({ message: `Registration for role '${role}' is not supported in this controller.` });
  } catch (err) {
    console.error("❌ Registration error:", err);
    res.status(500).json({ message: "Registration failed", error: err.message });
  }
};


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
