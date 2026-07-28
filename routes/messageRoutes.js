import express from "express";
import Message from "../models/Message.js";
import MessageRecipient from "../models/MessageRecipient.js";
import User from "../models/Users.js";
import QaoUser from "../models/QaoUser.js";
import { verifyToken } from "../middleware/auth.js"; 
// verifyToken should attach req.user

const router = express.Router();

/* =====================================================
   📤 SEND MESSAGE (Admin, Teacher, QAO)
   Can send:
   - To specific user IDs
   - OR by role (broadcast)
===================================================== */
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { subject, body, recipients, role } = req.body;

    if (!subject || !body)
      return res.status(400).json({ success: false, message: "Subject and body required" });

    // 1️⃣ Create core message
    const message = await Message.create({
      sender: req.user._id,
      subject,
      body,
    });

    // 2️⃣ Resolve recipients
    let users = [];

    if (recipients?.length) {
      users = await User.find({ _id: { $in: recipients } });
    } else if (role) {
      users = await User.find({ role });
    } else {
      return res.status(400).json({
        success: false,
        message: "Provide recipients array OR role",
      });
    }

    // 3️⃣ Insert delivery records
    const rows = users.map((u) => ({
      message: message._id,
      recipient: u._id,
    }));

    await MessageRecipient.insertMany(rows, { ordered: false });

    // 4️⃣ Emit socket to online users
    const onlineUsers = req.app.get("onlineUsers");
const io = req.app.get("io");

users.forEach((u) => {
  const socketId = onlineUsers.get(u._id.toString());
  if (socketId) {
    io.to(socketId).emit("message:new", { messageId: message._id });
  }
});


    res.status(201).json({ success: true, message });

  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
});


/* =====================================================
   📥 GET INBOX (For Logged In User)
===================================================== */
router.get("/inbox", verifyToken, async (req, res) => {
  try {
    const inbox = await MessageRecipient.find({
      recipient: req.user._id,
    })
      .populate({
        path: "message",
        populate: { path: "sender", select: "fullName role" },
      })
      .sort({ createdAt: -1 });

    res.json({ success: true, inbox });

  } catch (error) {
    console.error("Inbox error:", error);
    res.status(500).json({ success: false, message: "Failed to load inbox" });
  }
});


/* =====================================================
   📥 GET MESSAGES FOR TEACHER (from Admin/QAO broadcasts)
===================================================== */
router.get("/teacher/:teacherId", verifyToken, async (req, res) => {
  try {
    const recipientRecords = await MessageRecipient.find({ recipient: req.params.teacherId })
      .sort({ createdAt: -1 })
      .lean();

    const messages = await Promise.all(
      recipientRecords.map(async (r) => {
        const message = await Message.findById(r.message).lean();
        if (!message) return null;

        let senderName = "Unknown";
        let senderRole = "unknown";
        let senderEmail = "";

        try {
          const user = await User.findById(message.sender).select("fullName role email").lean();
          if (user) {
            senderName = user.fullName || "Unknown";
            senderRole = user.role || "unknown";
            senderEmail = user.email || "";
          } else {
            const qaoUser = await QaoUser.findById(message.sender).select("name role email").lean();
            if (qaoUser) {
              senderName = qaoUser.name || "Unknown";
              senderRole = qaoUser.role || "qao";
              senderEmail = qaoUser.email || "";
            }
          }
        } catch (err) {
          console.error("Error fetching sender:", err);
        }

        const roleLabel = senderRole === "admin" ? "Admin" : senderRole === "qao" ? "Tutor Manager" : senderRole;

        return {
          _id: message._id,
          subject: message.subject,
          body: message.body,
          createdAt: message.createdAt,
          senderName,
          senderRole,
          roleLabel,
          senderEmail,
          recipientId: r._id,
        };
      })
    );

    const validMessages = messages.filter(Boolean);
    res.json({ success: true, messages: validMessages });
  } catch (error) {
    console.error("Fetch teacher messages error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch messages" });
  }
});

/* =====================================================
   🗑️ DELETE MESSAGE
===================================================== */
router.delete("/recipient/:recipientId", verifyToken, async (req, res) => {
  try {
    const deleted = await MessageRecipient.findOneAndDelete({
      _id: req.params.recipientId,
      recipient: req.user._id,
    });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Message not found or access denied" });
    }

    res.json({ success: true, message: "Message deleted" });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({ success: false, message: "Failed to delete message" });
  }
});

/* =====================================================
   📖 MARK MESSAGE AS READ
===================================================== */
router.post("/:messageId/read", verifyToken, async (req, res) => {
  try {
    await MessageRecipient.findOneAndUpdate(
      {
        message: req.params.messageId,
        recipient: req.user._id,
      },
      {
        isRead: true,
        readAt: new Date(),
      }
    );

    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to mark read" });
  }
});


export default router;
