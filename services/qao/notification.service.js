import Notification from "../../models/Notification.js";
import { emitToQaos, emitToTeacher } from "./notify.js";

// Persistent notification service layered on the socket system. Creates a
// durable Notification doc AND emits the same event to the recipient room.
// Payloads never contain student PII.

export async function createNotification({
  userId,
  role = "teacher",
  title = "",
  message,
  type = "info",
  link = null,
  emitEvent = null,
  socketUserId = null,
}) {
  const n = await Notification.create({
    userId,
    role,
    title,
    message: String(message || "").slice(0, 400),
    type: ["info", "alert", "warning", "broadcast"].includes(type) ? type : "info",
    link: link || null,
  });
  if (emitEvent && userId) {
    const payload = { notificationId: n._id, title, message: n.message, type: n.type };
    if (role === "qao") emitToQaos(emitEvent, payload);
    else emitToTeacher(socketUserId || userId, emitEvent, payload);
  }
  return n;
}

// Broadcast a durable notification to ALL qao users (emits to the qaos room).
export async function notifyAllQaos({ title = "", message, type = "alert", emitEvent = null }) {
  const doc = await Notification.create({
    // Single shared doc; role=qao. Queryable by role, not by a single userId.
    userId: null,
    role: "qao",
    title,
    message: String(message || "").slice(0, 400),
    type,
  });
  if (emitEvent) {
    emitToQaos(emitEvent, { notificationId: doc._id, title, message: doc.message, type: doc.type });
  }
  return doc;
}

// QAO gets their notifications. `role === "qao"` matches notifications targeted
// to the qao role, including broadcast docs (userId null).
export async function listForQao({ limit = 50 } = {}) {
  return Notification.find({ role: "qao" })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean();
}

export async function markReadQao(id) {
  const n = await Notification.findOneAndUpdate(
    { _id: id, role: "qao" },
    { read: true },
    { new: true }
  );
  if (!n) throw new Error("Notification not found");
  return n;
}

export async function markAllReadQao() {
  await Notification.updateMany({ role: "qao", read: false }, { read: true });
  return { ok: true };
}

export async function unreadCountQao() {
  return Notification.countDocuments({ role: "qao", read: false });
}