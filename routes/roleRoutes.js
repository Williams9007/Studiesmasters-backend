import express from "express";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import Admin from "../models/admin.js";
import { verifyToken } from "../middleware/auth.js";

const router = express.Router();

/**
 * POST /api/role/select-role
 * Body: { userId, role }
 * Purpose: Assign role to a user
 */
router.post("/select-role", verifyToken, async (req, res) => {
  try {
    const { userId, role } = req.body;
    if (!role || !userId) {
      return res.status(400).json({ error: "userId and role are required" });
    }

    const validRoles = ["student", "teacher", "admin", "subadmin", "qao"];
    if (!validRoles.includes(role.toLowerCase())) {
      return res.status(400).json({ error: `Invalid role. Must be one of ${validRoles.join(", ")}` });
    }

    let updatedUser;

    switch (role.toLowerCase()) {
      case "student":
        updatedUser = await Student.findByIdAndUpdate(userId, { role: "Student" }, { new: true });
        break;
      case "teacher":
        updatedUser = await Teacher.findByIdAndUpdate(userId, { role: "Teacher" }, { new: true });
        break;
      case "admin":
      case "subadmin":
      case "qao":
        updatedUser = await Admin.findByIdAndUpdate(userId, { role: role.charAt(0).toUpperCase() + role.slice(1) }, { new: true });
        break;
    }

    if (!updatedUser) return res.status(404).json({ error: "User not found" });

    return res.json({
      success: true,
      message: `Role successfully set to ${role}`,
      user: updatedUser,
    });
  } catch (err) {
    console.error("Error in /select-role:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
