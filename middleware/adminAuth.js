import jwt from "jsonwebtoken";

export const adminAuth = (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    console.log("🔍 adminAuth - Authorization header:", authHeader ? "exists" : "missing");
    
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "")
      : null;

    if (!token) {
      console.log("❌ adminAuth - No token found");
      return res.status(401).json({ error: "Access denied. No token provided." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("✅ adminAuth - Token verified. Decoded:", decoded);

    // ✅ Only allow admins
    if (!decoded.role || !["MAIN_ADMIN", "MINOR_ADMIN"].includes(decoded.role)) {
      console.log("❌ adminAuth - Forbidden. Role:", decoded.role, "Allowed:", ["MAIN_ADMIN", "MINOR_ADMIN"]);
      return res.status(403).json({ error: "Forbidden. Admins only." });
    }

    console.log("✅ adminAuth - Access granted for role:", decoded.role);
    req.admin = decoded; // attach decoded info to req.admin
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      console.log("❌ adminAuth - Token expired");
      return res.status(401).json({ error: "Token expired. Please login again." });
    }
    console.error("❌ adminAuth error:", err.message);
    res.status(400).json({ error: "Invalid token" });
  }
};
