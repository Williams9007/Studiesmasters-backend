import express from "express";
import Message from "../models/Message.js";
import MessageRecipient from "../models/MessageRecipient.js";
import User from "../models/user.js";
import { verifyAuth } from "../middleware/verifyAuth.js"; 
// verifyAuth should attach req.user

const router = express.Router();

/* =====================================================
   📤 SEND MESSAGE (Admin, Teacher, QAO)
   Can send:
   - To specific user IDs
   - OR by role (broadcast)
===================================================== */
router.post("/send", verifyAuth, async (req, res) => {
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
router.get("/inbox", verifyAuth, async (req, res) => {
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
   📖 MARK MESSAGE AS READ
===================================================== */
router.post("/:messageId/read", verifyAuth, async (req, res) => {
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
