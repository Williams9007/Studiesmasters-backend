import jwt from "jsonwebtoken";
import Admin from "../models/admin.js";

export const verifyAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    // ✅ verify token safely
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        console.warn("⚠️ Admin token expired.");
        return res.status(401).json({ message: "Session expired. Please log in again." });
      } else {
        console.error("❌ Invalid admin token:", err.message);
        return res.status(401).json({ message: "Invalid token." });
      }
    }

    // ✅ confirm admin exists and is authorized
    const admin = await Admin.findById(decoded.id);
    if (!admin || decoded.role !== "admin") {
      return res.status(403).json({ message: "Access denied." });
    }

    req.admin = admin;
    next();
  } catch (err) {
    console.error("❌ Admin verification error:", err);
    res.status(500).json({ message: "Server error verifying admin token." });
  }
};
