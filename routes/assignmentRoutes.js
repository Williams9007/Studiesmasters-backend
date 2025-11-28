import express from "express";
import Assignment from "../models/Assignment.js";
import Teacher from "../models/teacher.js";
import Subject from "../models/Subject.js";
import { verifyToken } from "../middleware/auth.js";

const router = express.Router();

// ==================== Create a new assignment ====================
router.post("/", verifyToken, async (req, res) => {
  try {
    const { title, description, subjectId, teacherId, dueDate } = req.body;

    if (!title || !subjectId || !teacherId) {
      return res.status(400).json({ message: "Title, subjectId, and teacherId are required" });
    }

    const assignment = await Assignment.create({
      title,
      description,
      subjectId,
      teacherId,
      dueDate,
    });

    // Add assignment to teacher's assignmentsGiven
    await Teacher.findByIdAndUpdate(teacherId, { $push: { assignmentsGiven: assignment._id } });

    res.status(201).json(assignment);
  } catch (err) {
    console.error("Error creating assignment:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Get all assignments ====================
router.get("/", async (req, res) => {
  try {
    const assignments = await Assignment.find()
      .populate("teacherId", "fullName email")
      .populate("subjectId", "name curriculum classTime")
      .lean();
    res.json(assignments);
  } catch (err) {
    console.error("Error fetching assignments:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Get single assignment ====================
router.get("/:id", async (req, res) => {
  try {
    const assignment = await Assignment.findById(req.params.id)
      .populate("teacherId", "fullName email")
      .populate("subjectId", "name curriculum classTime")
      .lean();
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    res.json(assignment);
  } catch (err) {
    console.error("Error fetching assignment:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Update assignment ====================
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const assignment = await Assignment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    res.json(assignment);
  } catch (err) {
    console.error("Error updating assignment:", err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== Delete assignment ====================
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const assignment = await Assignment.findByIdAndDelete(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });

    // Remove assignment from teacher's assignmentsGiven
    await Teacher.findByIdAndUpdate(assignment.teacherId, { $pull: { assignmentsGiven: assignment._id } });

    res.json({ message: "Assignment deleted successfully" });
  } catch (err) {
    console.error("Error deleting assignment:", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
