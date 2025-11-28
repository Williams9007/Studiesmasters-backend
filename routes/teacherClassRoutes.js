import express from "express";
import TeacherAssignment from "../models/TeacherAssignment.js";
import ClassEnrollment from "../models/Classenrollment.js";
import Teacher from "../models/teacher.js";
import User from "../models/user.js";

const router = express.Router();

/* ==============================
   👩‍🏫 ASSIGN TEACHER TO A CLASS
   ============================== */
router.post("/assign", async (req, res) => {
  try {
    const { teacherId, curriculum, package: pkg, grade, subject } = req.body;

    if (!teacherId || !curriculum || !pkg || !grade || !subject) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const existing = await TeacherAssignment.findOne({
      teacherId,
      curriculum,
      package: pkg,
      grade,
      subject,
    });

    if (existing) {
      return res.status(400).json({ message: "Teacher already assigned to this class" });
    }

    const newAssign = await TeacherAssignment.create({
      teacherId,
      curriculum,
      package: pkg,
      grade,
      subject,
    });

    res.status(201).json(newAssign);
  } catch (err) {
    console.error("Error assigning teacher:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ==============================
   📋 GET ALL ASSIGNMENTS (ADMIN)
   ============================== */
router.get("/", async (req, res) => {
  try {
    const assignments = await TeacherAssignment.find()
      .populate("teacherId", "fullName email")
      .lean();
    res.json(assignments);
  } catch (err) {
    console.error("Error fetching assignments:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ==============================
   🎓 GET STUDENTS IN TEACHER'S CLASS
   ============================== */
router.get("/students/:teacherId", async (req, res) => {
  try {
    // find all classes assigned to this teacher
    const assignments = await TeacherAssignment.find({ teacherId: req.params.teacherId }).lean();

    if (!assignments.length) {
      return res.status(404).json({ message: "No classes assigned to this teacher" });
    }

    // find enrolled students that match each assignment
    const allStudents = [];
    for (const assign of assignments) {
      const enrolled = await ClassEnrollment.find({
        curriculum: assign.curriculum,
        package: assign.package,
        grade: assign.grade,
        subject: assign.subject,
      })
        .populate("studentId", "fullName email grade")
        .lean();

      allStudents.push({
        class: `${assign.curriculum} - ${assign.package} - ${assign.grade} - ${assign.subject}`,
        students: enrolled.map((e) => e.studentId),
      });
    }

    res.json(allStudents);
  } catch (err) {
    console.error("Error fetching teacher students:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ==============================
   ❌ REMOVE TEACHER ASSIGNMENT
   ============================== */
router.delete("/:id", async (req, res) => {
  try {
    const assign = await TeacherAssignment.findByIdAndDelete(req.params.id);
    if (!assign) return res.status(404).json({ message: "Assignment not found" });
    res.json({ message: "Assignment deleted successfully" });
  } catch (err) {
    console.error("Error deleting assignment:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
