import jwt from "jsonwebtoken";

export const adminAuth = (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "")
      : null;

    if (!token) {
      return res.status(401).json({ error: "Access denied. No token provided." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ Only allow admins
    if (!decoded.role || !["MAIN_ADMIN", "MINOR_ADMIN"].includes(decoded.role)) {
      return res.status(403).json({ error: "Forbidden. Admins only." });
    }

    req.admin = decoded; // attach decoded info to req.admin
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired. Please login again." });
    }
    res.status(400).json({ error: "Invalid token" });
  }
};
