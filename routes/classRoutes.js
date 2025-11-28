import express from "express";
import ClassEnrollment from "../models/ClassEnrollment.js";
import User from "../models/user.js";

const router = express.Router();

/* ==============================
   📚 CREATE ENROLLMENT (manual add)
   ============================== */
router.post("/", async (req, res) => {
  try {
    const { studentId, curriculum, package: pkg, grade, subject } = req.body;

    if (!studentId || !curriculum || !pkg || !grade || !subject) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const count = await ClassEnrollment.countDocuments({
      curriculum,
      package: pkg,
      grade,
      subject,
    });

    if (count >= 30) {
      return res.status(400).json({ message: `Class for ${subject} (Grade ${grade}) is full.` });
    }

    const exists = await ClassEnrollment.findOne({
      studentId,
      curriculum,
      package: pkg,
      grade,
      subject,
    });

    if (exists) {
      return res.status(400).json({ message: "Student already enrolled in this subject" });
    }

    const newEnrollment = await ClassEnrollment.create({
      studentId,
      curriculum,
      package: pkg,
      grade,
      subject,
    });

    res.status(201).json(newEnrollment);
  } catch (err) {
    console.error("Error creating enrollment:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ==============================
   📋 GET ALL ENROLLMENTS
   ============================== */
router.get("/", async (req, res) => {
  try {
    const enrollments = await ClassEnrollment.find()
      .populate("studentId", "fullName email grade")
      .lean();
    res.json(enrollments);
  } catch (err) {
    console.error("Error fetching enrollments:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ==============================
   🎓 GET ENROLLMENTS BY CLASS
   (filter by curriculum, package, grade, subject)
   ============================== */
router.get("/filter", async (req, res) => {
  try {
    const { curriculum, package: pkg, grade, subject } = req.query;
    const filter = {};
    if (curriculum) filter.curriculum = curriculum;
    if (pkg) filter.package = pkg;
    if (grade) filter.grade = grade;
    if (subject) filter.subject = subject;

    const enrollments = await ClassEnrollment.find(filter)
      .populate("studentId", "fullName email grade")
      .lean();

    res.json(enrollments);
  } catch (err) {
    console.error("Error filtering enrollments:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ==============================
   👤 GET ENROLLMENTS BY STUDENT
   ============================== */
router.get("/student/:studentId", async (req, res) => {
  try {
    const enrollments = await ClassEnrollment.find({ studentId: req.params.studentId }).lean();
    res.json(enrollments);
  } catch (err) {
    console.error("Error fetching student enrollments:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ==============================
   ❌ DELETE ENROLLMENT
   ============================== */
router.delete("/:id", async (req, res) => {
  try {
    const enrollment = await ClassEnrollment.findByIdAndDelete(req.params.id);
    if (!enrollment) return res.status(404).json({ message: "Enrollment not found" });
    res.json({ message: "Enrollment removed successfully" });
  } catch (err) {
    console.error("Error deleting enrollment:", err);
    res.status(500).json({ message: err.message });
  }
});

// ✅ Get all classes for a specific student
router.get("/student/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const classes = await Class.find({ studentsEnrolled: id })
      .populate("subject")
      .populate("teacher", "name email");

    if (!classes.length) {
      return res.status(404).json({ message: "No classes found for this student" });
    }

    res.json(classes);
  } catch (error) {
    console.error("❌ Error fetching class info:", error);
    res.status(500).json({ message: "Server error fetching class info" });
  }
})

export default router;
