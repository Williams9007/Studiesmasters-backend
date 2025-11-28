import Broadcast from "../models/Broadcast.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";

//  Teacher sends message to their students
export const sendBroadcast = async (req, res) => {
  try {
    const { message } = req.body;
    const teacherId = req.user.id; // from verifyTeacher middleware

    const teacher = await Teacher.findById(teacherId).populate("subjects");
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });

    // Get all students that take any of the teacher’s subjects
    const students = await Student.find({ subjects: { $in: teacher.subjects } });

    const broadcast = new Broadcast({
      message,
      teacher: teacher._id,
      subject: teacher.subjects,
      recipients: students.map((s) => s._id),
    });

    await broadcast.save();
    res.status(201).json({ message: "Broadcast sent successfully", broadcast });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

//  Student fetches broadcasts relevant to their subjects
export const getBroadcastsForStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const student = await Student.findById(studentId).populate("subjects");
    if (!student) return res.status(404).json({ message: "Student not found" });

    const broadcasts = await Broadcast.find({
      subject: { $in: student.subjects },
    })
      .populate("teacher", "name")
      .sort({ createdAt: -1 });

    res.status(200).json(broadcasts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
