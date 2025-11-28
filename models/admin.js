import mongoose from "mongoose";

const adminSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true, minlength: 6 },

  // Role can be Admin, SubAdmin, or QAO
  role: { 
    type: String, 
    enum: ["Admin", "SubAdmin", "QAO"], 
    default: "Admin",
    required: true
  },

  adminCode: { type: String, required: true }, // optional code for verification
}, { timestamps: true });

export default mongoose.model("Admin", adminSchema);
