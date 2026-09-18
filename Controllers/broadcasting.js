// backend/controllers/broadcasting.js
import Broadcast from "../models/Broadcast.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import QAO from "../models/QaoUser.js";
import Notification from "../models/Notification.js";
import { sendPushToAll, sendPushToRole, sendPushToStudents, sendPushToUsers } from "./pushNotificationController.js";
import { emitToAdmin, emitToAllTeachers, emitToQaos, emitToStudent, emitToStudents, emitToTeacher } from "../services/qao/notify.js";

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
    const { subject, message, link, recipientType, recipientId, recipientModel, recipients } = req.body;

    if (!message?.trim())
      return res.status(400).json({ message: "Message cannot be empty." });

    // Handle attachment if uploaded via multer — store the web URL path
    // (multer returns an absolute filesystem path, so normalize to /uploads/...)
    const attachment = req.file ? `/uploads/broadcasts/${req.file.filename}` : null;
    const optionalLink = link?.trim() || null;

    // --- Determine recipients ---
    let usersToNotify = [];
    let modelName = null;
    let studentIds = [];
    let teacherIds = [];
    let qaoIds = [];

    if (recipients?.length > 0) {
      usersToNotify = recipients;
      modelName = recipientModel || "Student";
      if (modelName === "Student") studentIds = recipients;
      else if (modelName === "Teacher") teacherIds = recipients;
      else if (modelName === "QaoUser") qaoIds = recipients;
    } else if (recipientId) {
      // Single recipient - could be student, teacher, or tutor manager
      usersToNotify = [recipientId];
      modelName = recipientModel || "Student";
      if (modelName === "Student") studentIds = [recipientId];
      else if (modelName === "Teacher") teacherIds = [recipientId];
      else if (modelName === "QaoUser") qaoIds = [recipientId];
    } else {
      switch (recipientType) {
        case "students":
          studentIds = (await Student.find({})).map((s) => s._id);
          usersToNotify = studentIds;
          modelName = "Student";
          break;
        case "teachers":
          teacherIds = (await Teacher.find({})).map((t) => t._id);
          usersToNotify = teacherIds;
          modelName = "Teacher";
          break;
        case "tutormanagers":
          qaoIds = (await QAO.find({})).map((q) => q._id);
          usersToNotify = qaoIds;
          modelName = "QaoUser";
          break;
        default:
          const students = await Student.find({});
          const teachers = await Teacher.find({});
          const qaos = await QAO.find({});
          studentIds = students.map((s) => s._id);
          teacherIds = teachers.map((t) => t._id);
          qaoIds = qaos.map((q) => q._id);
          usersToNotify = [
            ...studentIds,
            ...teacherIds,
            ...qaoIds,
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
      link: optionalLink,
      attachment,
    });
    await broadcast.save();

    // --- Create notifications ---
    const roleForUser = (uId) => {
      const id = String(uId);
      if (modelName === "Student" || studentIds.some((studentId) => String(studentId) === id)) return "student";
      if (modelName === "Teacher" || teacherIds.some((teacherId) => String(teacherId) === id)) return "teacher";
      if (modelName === "QaoUser" || qaoIds.some((qaoId) => String(qaoId) === id)) return "qao";
      return "student";
    };
    const NotificationModel = Notification;
    const notifications = usersToNotify.map((uId) => ({
      userId: uId,
      role: roleForUser(uId),
      type: "broadcast",
      message: subject ? `${subject} — ${message}` : message,
      link: optionalLink,
      attachment,
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
        link: broadcast.link || null,
        attachment: broadcast.attachment || null,
        createdAt: broadcast.createdAt.toISOString(),
        updatedAt: broadcast.updatedAt.toISOString(),
      };
      if (recipientId) {
        if (modelName === "Student") emitToStudent(recipientId, "broadcast:new", broadcastData);
        else if (modelName === "Teacher") emitToTeacher(recipientId, "broadcast:new", broadcastData);
        else if (modelName === "QaoUser") emitToQaos("broadcast:new", broadcastData);
      } else if (recipientType === "students") {
        emitToStudents(studentIds, "broadcast:new", broadcastData);
      } else if (recipientType === "teachers") {
        emitToAllTeachers("broadcast:new", broadcastData);
      } else if (recipientType === "tutormanagers") {
        emitToQaos("broadcast:new", broadcastData);
      } else {
        emitToStudents(studentIds, "broadcast:new", broadcastData);
        emitToAllTeachers("broadcast:new", broadcastData);
        emitToQaos("broadcast:new", broadcastData);
        emitToAdmin("broadcast:new", broadcastData);
      }
      emitToAdmin("new-broadcast", broadcastData);
      console.log("📢 Broadcast emitted:", broadcastData.message);
    } else {
      console.warn("❌ Socket.IO not initialized");
    }

    const pushTitle = subject || "StudiesMasters announcement";
    const pushUrl = optionalLink || "/#/notifications";
    try {
      if (recipientId) {
        await sendPushToUsers([recipientId], pushTitle, message, pushUrl, { type: "broadcast", tag: `broadcast-${broadcast._id}` });
      } else if (recipientType === "students") {
        await sendPushToStudents(studentIds, pushTitle, message, pushUrl, { type: "broadcast", tag: `broadcast-${broadcast._id}` });
      } else if (recipientType === "teachers") {
        await sendPushToRole("teacher", pushTitle, message, pushUrl, { type: "broadcast", tag: `broadcast-${broadcast._id}` });
      } else if (recipientType === "tutormanagers") {
        await sendPushToRole("qao", pushTitle, message, pushUrl, { type: "broadcast", tag: `broadcast-${broadcast._id}` });
      } else {
        await sendPushToAll(pushTitle, message, pushUrl, { type: "broadcast", tag: `broadcast-${broadcast._id}` });
      }
    } catch (pushErr) {
      console.warn("Broadcast push delivery failed:", pushErr.message);
    }

    res.status(201).json({ message: "Broadcast sent successfully", broadcast });
  } catch (err) {
    console.error("❌ Broadcast error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
