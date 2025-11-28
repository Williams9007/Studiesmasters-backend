import Subject from "../models/Subject.js";

// GET subjects by package & grade (supports case-insensitive matching)
export const getSubjectsByPackage = async (req, res) => {
  try {
    const { package: pkg } = req.params;
    const { grade } = req.query;

    if (!pkg) {
      return res.status(400).json({ message: "Package is required" });
    }

    // Build case-insensitive query
    const query = {
      package: { $regex: new RegExp(`^${pkg}$`, "i") }
    };

    if (grade) {
      query.grade = { $regex: new RegExp(`^${grade}$`, "i") };
    }

    const subjects = await Subject.find(query);

    return res.status(200).json(subjects);
  } catch (err) {
    console.error("Error fetching subjects:", err);
    return res.status(500).json({ message: "Server error" });
  }
};
