// Package.js
import mongoose from "mongoose";

const PackageSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  duration: { type: String, required: true }, // e.g., "3 months"
});

export default mongoose.model("Package", PackageSchema);
