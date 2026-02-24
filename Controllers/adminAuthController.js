import bcrypt from "bcryptjs";
import Admin from "../models/admin.js";

export const adminLogin = async (req, res) => {
  const { email, password } = req.body;

  const admin = await Admin.findOne({ email });
  if (!admin) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const isMatch = await bcrypt.compare(password, admin.password);
  if (!isMatch) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  res.json({
    admin: {
      _id: admin._id,
      role: admin.role,
      email: admin.email,
    },
  });
};
