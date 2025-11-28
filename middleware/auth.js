import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";

const router = express.Router();

// ==================== Login ====================
router.post("/login", async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ message: "Email, password, and role are required" });
    }

    let user;
    if (role === "student") {
      user = await Student.findOne({ email });
    } else if (role === "teacher") {
      user = await Teacher.findOne({ email });
    } else {
      return res.status(400).json({ message: "Invalid role" });
    }

    if (!user) return res.status(404).json({ message: "User not found" });

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    // Generate JWT
    const token = jwt.sign(
      { id: user._id, role: role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ message: "Login successful", user, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error during login" });
  }
});

// ==================== Middleware: Verify Token ====================
export const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    let token = authHeader?.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : null;

    if (!token && req.cookies?.token) token = req.cookies.token;

    if (!token) return res.status(401).json({ error: "Access denied. No token provided." });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired. Please login again." });
    }
    res.status(400).json({ error: "Invalid token" });
  }
};

export default router;
