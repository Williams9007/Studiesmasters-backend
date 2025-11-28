// backend/controllers/studentController.js
import Student from "../models/Student.js";

export const getStudentById = async (req, res) => {
  try {
    const student = await Student.findById(req.params.id)
      .populate("subjects") // 👈 this ensures full subject details (name, grade, price)
      .lean();

    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    res.json(student);
  } catch (error) {
    console.error("Error fetching student:", error);
    res.status(500).json({ message: "Server error" });
  }
};
