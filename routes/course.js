import express from "express";
import Student from "../models/Student.js";

const router = express.Router();

// ==================== Register a student for a course ====================
router.post("/register", async (req, res) => {
  try {
    const { studentId, curriculum, package: pkg, grade, subjectsEnrolled } = req.body;

    if (!studentId || !curriculum) {
      return res.status(400).json({ error: "studentId and curriculum are required" });
    }

    if (!["GES", "CAMBRIDGE"].includes(curriculum)) {
      return res.status(400).json({ error: "Invalid curriculum" });
    }

    const updateData = { curriculum };

    if (pkg) updateData.package = pkg;
    if (grade) updateData.grade = grade;
    if (subjectsEnrolled) updateData.subjectsEnrolled = subjectsEnrolled; // array of Subject IDs

    const student = await Student.findByIdAndUpdate(studentId, updateData, { new: true })
      .populate("subjectsEnrolled", "name curriculum classTime teacherId");

    if (!student) return res.status(404).json({ error: "Student not found" });

    res.json({ message: `Registered for ${curriculum} curriculum`, student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
