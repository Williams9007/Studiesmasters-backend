import express from "express";
import Pricing from "../models/Pricing.js";

const router = express.Router();

// Map grades to groups
const gradeGroupMap = {
  "Basic 4": "1-4",
  "Basic 5": "1-4",
  "Basic 6": "1-4",
  "JHS 1": "1-4",
  "JHS 2": "1-4",
  "JHS 3": "1-4",
  "SHS 1": "5-8",
  "SHS 2": "5-8",
  "SHS 3": "5-8",
  "Stage 4": "1-3",
  "Stage 5": "4-6",
  "Stage 6": "7-9",
};

router.get("/:curriculum/:packageCode", async (req, res) => {
  try {
    const { curriculum, packageCode } = req.params;
    const { grade } = req.query;

    if (!grade) return res.status(400).json({ message: "Grade is required" });

    const gradeGroup = gradeGroupMap[grade];
    if (!gradeGroup) return res.status(400).json({ message: "Invalid grade" });

    const pricingData = await Pricing.findOne({ curriculum, packageCode, gradeGroup });

    if (!pricingData) return res.status(404).json({ message: "Pricing not found" });

    res.json({ subjects: pricingData.subjects });
  } catch (err) {
    console.error("Error fetching pricing:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
