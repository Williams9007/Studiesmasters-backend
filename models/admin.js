// backend/models/admin.js
import mongoose from "mongoose";

const adminSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true }, // ✅ add this
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["MAIN_ADMIN", "MINOR_ADMIN"], default: "MINOR_ADMIN" },
  adminCode: { type: String, trim: true }, // ✅ add this
  otp: Number,
  otpExpires: Date,
  resetPasswordToken: String,
  resetPasswordExpires: Date,
}, { timestamps: true });

export default mongoose.models.Admin || mongoose.model("Admin", adminSchema);
