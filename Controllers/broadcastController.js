import Broadcast from "../models/Broadcast.js";
import Student from "../models/student.js";
import Teacher from "../models/teacher.js";
import QAO from "../models/QaoUser.js"; // if you have QAO model
import Notification from "../models/Notification.js";

export const sendBroadcast = async (req, res) => {
  try {
    const { subject, message, type, recipients } = req.body;
    if (!message?.trim())
      return res.status(400).json({ message: "Message cannot be empty." });

    let usersToNotify = [];

    // --- Determine recipients ---
    if (recipients && recipients.length > 0) {
      usersToNotify = recipients;
    } else {
      if (type === "students") {
        const students = await Student.find({});
        usersToNotify = students.map((s) => s._id);
      } else if (type === "teachers") {
        const teachers = await Teacher.find({});
        usersToNotify = teachers.map((t) => t._id);
      } else if (type === "qaos") {
        const qaos = await QAO.find({});
        usersToNotify = qaos.map((q) => q._id);
      } else {
        // all users
        const students = await Student.find({});
        const teachers = await Teacher.find({});
        const qaos = await QAO.find({});
        usersToNotify = [
          ...students.map((s) => s._id),
          ...teachers.map((t) => t._id),
          ...qaos.map((q) => q._id),
        ];
      }
    }

    // --- Save broadcast ---
    const broadcast = new Broadcast({
      subject,
      message,
      sender: req.user.id,
      recipients: usersToNotify,
    });
    await broadcast.save();

    // --- Create notifications ---
    const notifications = usersToNotify.map((uId) => ({
      user: uId,
      type: "broadcast",
      message: subject ? `${subject} — ${message}` : message,
      read: false,
    }));
    await Notification.insertMany(notifications);

    res.status(201).json({ message: "Broadcast sent successfully", broadcast });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
