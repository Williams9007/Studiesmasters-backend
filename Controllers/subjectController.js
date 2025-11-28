import Subject from "../models/subjectModel.js";

// GET subjects by package & grade
export const getSubjectsByPackageGrade = async (req, res) => {
  try {
    const { packageName, grade } = req.query;

    if (!packageName || !grade) {
      return res.status(400).json({ message: "packageName & grade required" });
    }

    // Fetch subjects matching package + grade
    const subjects = await Subject.find({ package: packageName, grade });

    // strict rule: max 3 subjects per grade
    const limitedSubjects = subjects.slice(0, 3);

    // calculate total price
    const totalPrice = limitedSubjects.reduce((sum, s) => sum + s.price, 0);

    // duration rules based on package
    let duration = 0;
    if (packageName.includes("SC")) duration = 2; // Example: Special Classes = 2 months
    else if (packageName.includes("OC")) duration = 1; // One-on-one = 1 month
    else duration = 1; // Default 1 month for others

    return res.json({
      packageName,
      grade,
      subjects: limitedSubjects,
      totalSubjects: limitedSubjects.length,
      duration,
      totalPrice,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
