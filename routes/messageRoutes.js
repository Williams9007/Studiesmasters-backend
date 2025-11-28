import express from "express";
import Message from "../models/Message.js";
import Teacher from "../models/teacher.js";
import QaoUser from "../models/QaoUser.js";
import { verifyQao } from "../middleware/verifyQao.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js"; // ✅ you'll add this middleware (shown below)

const router = express.Router();

/* =====================================================
   📨 1. QAO → Teacher  (Send Message)
===================================================== */
router.post("/send/qao", verifyQao, async (req, res) => {
  try {
    const { receiverId, subject, message } = req.body;

    if (!receiverId || !subject || !message)
      return res.status(400).json({ success: false, message: "All fields are required" });

    const newMessage = await Message.create({
      sender: req.user._id,
      receiver: receiverId,
      subject,
      message,
      senderRole: "qao",
      receiverRole: "teacher",
    });

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.error("QAO send message error:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
});

/* =====================================================
   💬 2. Teacher → QAO  (Reply or Send New)
===================================================== */
router.post("/send/teacher", verifyTeacher, async (req, res) => {
  try {
    const { qaoId, subject, message } = req.body;

    if (!qaoId || !subject || !message)
      return res.status(400).json({ success: false, message: "All fields are required" });

    const newMessage = await Message.create({
      sender: req.user._id,
      receiver: qaoId,
      subject,
      message,
      senderRole: "teacher",
      receiverRole: "qao",
    });

    res.status(201).json({ success: true, message: newMessage });
  } catch (error) {
    console.error("Teacher send message error:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
});

/* =====================================================
   🔁 3. Fetch Conversation Between QAO & Teacher
===================================================== */
router.get("/conversation/:qaoId/:teacherId", async (req, res) => {
  const { qaoId, teacherId } = req.params;

  try {
    const conversation = await Message.find({
      $or: [
        { sender: qaoId, receiver: teacherId },
        { sender: teacherId, receiver: qaoId },
      ],
    })
      .populate("sender", "fullName email")
      .populate("receiver", "fullName email")
      .sort({ createdAt: 1 });

    res.json({ success: true, messages: conversation });
  } catch (error) {
    console.error("Conversation fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch messages" });
  }
});

/* =====================================================
   📥 4. Get Inbox for QAO
===================================================== */
router.get("/inbox/qao", verifyQao, async (req, res) => {
  try {
    const messages = await Message.find({ receiver: req.user._id })
      .populate("sender", "fullName email role")
      .sort({ createdAt: -1 });

    res.json({ success: true, messages });
  } catch (error) {
    console.error("QAO inbox fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to load inbox" });
  }
});

/* =====================================================
   📥 5. Get Inbox for Teacher
===================================================== */
router.get("/inbox/teacher", verifyTeacher, async (req, res) => {
  try {
    const messages = await Message.find({ receiver: req.user._id })
      .populate("sender", "fullName email role")
      .sort({ createdAt: -1 });

    res.json({ success: true, messages });
  } catch (error) {
    console.error("Teacher inbox fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to load inbox" });
  }
});

/* =====================================================
   🧑‍🏫 6. Fetch Teachers (for QAO to Message)
===================================================== */
router.get("/teachers", verifyQao, async (req, res) => {
  try {
    const teachers = await Teacher.find().select("_id fullName email");
    res.json({ success: true, teachers });
  } catch (error) {
    console.error("Fetch teachers error:", error);
    res.status(500).json({ success: false, message: "Failed to load teachers" });
  }
});



// ✅ Get all messages for a teacher (including QAO replies)
router.get("/teacher/:teacherId", async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { sender: req.params.teacherId },
        { receiver: req.params.teacherId }
      ]
    })
      .populate("sender", "name role")
      .populate("receiver", "name role")
      .sort({ createdAt: -1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Teacher replies to a message from QAO
router.post("/reply/:messageId", async (req, res) => {
  try {
    const { reply, teacherId } = req.body;
    const originalMsg = await Message.findById(req.params.messageId);

    if (!originalMsg)
      return res.status(404).json({ message: "Message not found" });

    const replyMsg = await Message.create({
      sender: teacherId,
      receiver: originalMsg.sender, // QAO
      subject: `Re: ${originalMsg.subject}`,
      message: reply,
      senderRole: "teacher",
      receiverRole: "qao",
    });

    res.json(replyMsg);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


export default router;
