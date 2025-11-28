import Subject from "../models/subjectModel.js";

/**
 * GET /api/subjects/by-package/:package
 * Fetch subjects by package and optional grade (case-insensitive)
 */
export const getSubjectsByPackage = async (req, res) => {
  try {
    const { package: pkg } = req.params; // rename to avoid reserved word
    const { grade } = req.query;

    if (!pkg) {
      return res.status(400).json({ message: "Package name is required" });
    }

    // Build query
    const query = {
      package: { $regex: new RegExp(`^${pkg}$`, "i") },
    };

    if (grade && grade.trim() !== "") {
      query.grade = { $regex: new RegExp(`^${grade}$`, "i") };
    }

    // Fetch subjects
    const subjects = await Subject.find(query);

    if (!subjects || subjects.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No subjects found for package "${pkg}"${grade ? ` and grade "${grade}"` : ""}`,
      });
    }

    res.status(200).json(subjects);
  } catch (err) {
    console.error("Error fetching subjects:", err.message);
    res.status(500).json({
      success: false,
      message: "Server error while fetching subjects",
      error: err.message,
    });
  }
};
