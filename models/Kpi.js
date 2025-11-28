// backend/models/Kpi.js
import mongoose from "mongoose";

const kpiSchema = new mongoose.Schema(
  {
    metric: { type: String, required: true }, // e.g., "Timetables Approved"
    value: { type: Number, default: 0 },
    period: { type: String, default: "Monthly" }, // optional
  },
  { timestamps: true }
);

export default mongoose.model("Kpi", kpiSchema);
