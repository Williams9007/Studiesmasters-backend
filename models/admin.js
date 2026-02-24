// backend/models/admin.js
import mongoose from "mongoose";

const adminSchema = new mongoose.Schema({
  fullName: { type: String, required: true }, // ✅ add this
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["MAIN_ADMIN", "MINOR_ADMIN"], default: "MINOR_ADMIN" },
  adminCode: { type: String }, // ✅ add this
  otp: Number,
  otpExpires: Date,
  resetPasswordToken: String,
  resetPasswordExpires: Date,
});

export default mongoose.model("Admin", adminSchema);
