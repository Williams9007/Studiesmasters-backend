import Student from "../models/studentModel.js";
import Teacher from "../models/teacherModel.js";
import User from "../models/userModel.js"; // if you have a generic users collection

export const getQoaStats = async (req, res) => {
  try {
    const totalStudents = await Student.countDocuments();
    const totalTeachers = await Teacher.countDocuments();
    const totalUsers = await User.countDocuments();
    
    res.status(200).json({
      success: true,
      stats: {
        totalStudents,
        totalTeachers,
        totalUsers,
      },
    });
  } catch (error) {
    console.error("Error fetching QOA stats:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
