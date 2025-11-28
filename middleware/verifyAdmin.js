// backend/middleware/verifyAdmin.js
import jwt from "jsonwebtoken";
import Admin from "../models/admin.js";

export const verifyAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Find admin
    const admin = await Admin.findById(decoded.id);
    if (!admin || decoded.role !== "admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    req.admin = admin;
    next();
  } catch (err) {
    console.error("Admin verification error:", err);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    res.status(401).json({ message: "Invalid token" });
  }
};
