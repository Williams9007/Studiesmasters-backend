// backend/controllers/broadcasting.js
import Broadcast from "../models/Broadcast.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import QAO from "../models/QaoUser.js";
import Notification from "../models/Notification.js";

let io;

/**
 * Set the Socket.IO instance from server.js
 * Must be called during server init: setSocketIO(io)
 */
export const setSocketIO = (socketInstance) => {
  io = socketInstance;
};

/**
 * Send a broadcast to students, teachers, tutor managers, or all
 */
export const sendBroadcast = async (req, res) => {
  try {
    const { subject, message, recipientType, recipientId, recipientModel, recipients } = req.body;

    if (!message?.trim())
      return res.status(400).json({ message: "Message cannot be empty." });

    // Handle attachment if uploaded via multer
    const attachment = req.file ? req.file.path : null;

    // --- Determine recipients ---
    let usersToNotify = [];
    let modelName = null;

    if (recipients?.length > 0) {
      usersToNotify = recipients;
      modelName = recipientModel || "Student";
    } else if (recipientId) {
      // Single recipient - could be student, teacher, or tutor manager
      usersToNotify = [recipientId];
      modelName = recipientModel || "Student";
    } else {
      switch (recipientType) {
        case "students":
          usersToNotify = (await Student.find({})).map((s) => s._id);
          modelName = "Student";
          break;
        case "teachers":
          usersToNotify = (await Teacher.find({})).map((t) => t._id);
          modelName = "Teacher";
          break;
        case "tutormanagers":
          usersToNotify = (await QAO.find({})).map((q) => q._id);
          modelName = "QaoUser";
          break;
        default:
          const students = await Student.find({});
          const teachers = await Teacher.find({});
          const qaos = await QAO.find({});
          usersToNotify = [
            ...students.map((s) => s._id),
            ...teachers.map((t) => t._id),
            ...qaos.map((q) => q._id),
          ];
          modelName = undefined; // Mixed - use refPath to resolve each
      }
    }

    // --- Save broadcast ---
    const senderId = req.admin?.id || req.user?.id || req.admin?._id;
    if (!senderId) {
      return res.status(401).json({ message: "Unauthorized: sender not identified" });
    }

    const broadcast = new Broadcast({
      subject,
      message,
      sender: senderId,
      recipients: usersToNotify,
      recipientModel: modelName || undefined,
      type: recipientType || "all",
      recipientsCount: usersToNotify.length,
      attachment,
    });
    await broadcast.save();

    // --- Create notifications ---
    const NotificationModel = Notification;
    const notifications = usersToNotify.map((uId) => ({
      userId: uId,
      type: "broadcast",
      message: subject ? `${subject} — ${message}` : message,
      read: false,
    }));
    await NotificationModel.insertMany(notifications);

    // --- Populate sender for frontend ---
    await broadcast.populate("sender", "fullName email");

    // --- Emit to Socket.IO ---
    if (io) {
      const broadcastData = {
        _id: broadcast._id.toString(),
        subject: broadcast.subject,
        message: broadcast.message,
        sender: broadcast.sender, // fullName & email
        recipients: broadcast.recipients.map((id) => id.toString()),
        createdAt: broadcast.createdAt.toISOString(),
        updatedAt: broadcast.updatedAt.toISOString(),
      };
      io.emit("broadcast:new", broadcastData);
      console.log("📢 Broadcast emitted:", broadcastData.message);
    } else {
      console.warn("❌ Socket.IO not initialized");
    }

    res.status(201).json({ message: "Broadcast sent successfully", broadcast });
  } catch (err) {
    console.error("❌ Broadcast error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
