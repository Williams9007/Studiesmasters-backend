import jwt from "jsonwebtoken";
import Teacher from "../models/teacher.js";

export const verifyTeacher = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const teacher = await Teacher.findById(decoded.id);
    if (!teacher) return res.status(403).json({ message: "Access denied" });

    req.user = teacher;
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};
