import Class from "../models/Class.js";
import Teacher from "../models/teacher.js";
import User from "../models/User.js";

// ✅ Create a new class
export const createClass = async (req, res) => {
  try {
    const { className, curriculum, grade, subjects, teachers, startDate, duration, maxStudents } = req.body;

    const existingClass = await Class.findOne({ className });
    if (existingClass) {
      return res.status(400).json({ message: "Class name already exists" });
    }

    const newClass = new Class({
      className,
      curriculum,
      grade,
      subjects,
      teachers,
      startDate,
      duration,
      maxStudents,
    });

    await newClass.save();
    res.status(201).json({ message: "Class created successfully!", class: newClass });
  } catch (error) {
    res.status(500).json({ message: "Error creating class", error });
  }
};

// ✅ Get all classes
export const getAllClasses = async (req, res) => {
  try {
    const classes = await Class.find()
      .populate("teachers", "name email")
      .populate("students", "name email");
    res.status(200).json(classes);
  } catch (error) {
    res.status(500).json({ message: "Error fetching classes", error });
  }
};

// ✅ Add student to a class
export const addStudentToClass = async (req, res) => {
  try {
    const { classId, studentId } = req.body;
    const classItem = await Class.findById(classId);

    if (!classItem) return res.status(404).json({ message: "Class not found" });
    if (classItem.students.includes(studentId))
      return res.status(400).json({ message: "Student already enrolled" });

    if (classItem.students.length >= classItem.maxStudents) {
      return res.status(400).json({ message: "Class is full" });
    }

    classItem.students.push(studentId);
    await classItem.save();

    res.status(200).json({ message: "Student added successfully", classItem });
  } catch (error) {
    res.status(500).json({ message: "Error adding student", error });
  }
};
