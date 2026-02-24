import Admin from "../models/admin.js";
import Student from "../models/student.js";
import Teacher from "../models/teacher.js";
import Payment from "../models/Payment.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/* =======================
   ADMIN LOGIN (EXISTING)
======================= */
export const loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await Admin.findOne({ email });
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    return res.status(200).json({
      success: true,
      message: "Login successful",
      admin: {
        _id: admin._id,
        email: admin.email,
        role: admin.role,
      },
      token,
    });
  } catch (error) {
    console.error("❌ Admin login error:", error);
    return res.status(500).json({ message: "Login failed" });
  }
};

/* =======================
   ADMIN DASHBOARD DATA
======================= */
export const getAdminOverview = async (req, res) => {
  try {
    const [
      totalStudents,
      totalTeachers,
      totalPayments,
      recentStudents,
      recentPayments,
    ] = await Promise.all([
      Student.countDocuments(),
      Teacher.countDocuments(),
      Payment.countDocuments(),
      Student.find().sort({ createdAt: -1 }).limit(5),
      Payment.find().sort({ createdAt: -1 }).limit(5),
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        totalStudents,
        totalTeachers,
        totalPayments,
      },
      recentStudents,
      recentPayments,
    });
  } catch (error) {
    console.error("❌ Admin overview error:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch admin dashboard data" });
  }
};
