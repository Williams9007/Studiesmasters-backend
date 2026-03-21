// middleware/studentAuth.js
import jwt from "jsonwebtoken";
import Student from "../models/Student.js";

export const studentAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const student = await Student.findById(decoded.id).select("-password");
    if (!student) return res.status(404).json({ message: "Student not found" });

    req.user = student;
    next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
