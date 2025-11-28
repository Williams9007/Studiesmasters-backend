import express from "express";
import Subject from "../models/Subject.js";

const router = express.Router();

/**
 * @route   GET /api/subjects/by-package/:package
 * @desc    Fetch subjects by package and optional grade (case-insensitive)
 * @access  Public
 */
router.get("/by-package/:package", async (req, res) => {
  try {
    const { package: pkg } = req.params; // renamed variable since "package" is reserved
    const { grade } = req.query;

    // ✅ Build a flexible query
    const query = {
      package: { $regex: new RegExp(`^${pkg}$`, "i") },
    };

    if (grade && grade.trim() !== "") {
      query.grade = { $regex: new RegExp(`^${grade}$`, "i") };
    }

    // ✅ Fetch matching subjects
    const subjects = await Subject.find(query);

    if (!subjects || subjects.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No subjects found for package "${pkg}"${grade ? ` and grade "${grade}"` : ""}`,
      });
    }

    res.status(200).json(subjects);
  } catch (error) {
    console.error("❌ Error fetching subjects:", error.message);
    res.status(500).json({
      success: false,
      message: "Server error while fetching subjects",
      error: error.message,
    });
  }
});

export default router;
