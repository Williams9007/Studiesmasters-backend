// Package.js
import mongoose from "mongoose";

const PackageSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true },
  duration: { type: String, required: true, trim: true }, // e.g., "3 months"
}, { timestamps: true });

export default mongoose.models.Package || mongoose.model("Package", PackageSchema);
