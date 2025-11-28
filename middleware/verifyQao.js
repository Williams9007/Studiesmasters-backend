import jwt from "jsonwebtoken";
import QaoUser from "../models/QaoUser.js"; // corrected model

export const verifyQao = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const qao = await QaoUser.findById(decoded.id);
    if (!qao) {
      return res.status(403).json({ message: "Access denied" });
    }

    req.user = qao; // attach QAO user to request
    next();
  } catch (err) {
    console.error("verifyQao error:", err);
    res.status(401).json({ message: "Invalid or expired token" });
  }
};
