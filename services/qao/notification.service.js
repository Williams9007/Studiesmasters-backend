// services/qao/notification.service.js
//
// Single source of truth for durable (Mongo-backed) + realtime (socket.io)
// notifications used by the teacher, student, QAO and admin surfaces.
//
// NOTE: this file previously contained three overlapping copies of the same
// function declarations, which made the module a hard SyntaxError
// ("Identifier 'notifyAllQaos' has already been declared") and prevented the
// whole backend from booting. It is now a single, deduplicated copy.
import Notification from "../../models/Notification.js";
import { emitToQaos, emitToTeacher, emitToStudent, emitToStudents, emitToAllTeachers } from "./notify.js";

const TYPES = ["info", "alert", "warning", "broadcast"];

const safeType = (type) => (TYPES.includes(type) ? type : "info");
const safeTitle = (title) => String(title || "").slice(0, 200);
const safeMessage = (message) => String(message || "").slice(0, 400);

// ─── Core: create a persistent notification + optional socket emit ───────────

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
    userId: userId || null,
    role,
    title: safeTitle(title),
    message: safeMessage(message),
    type: safeType(type),
    link: link || null,
  });
  if (emitEvent && userId) {
    const payload = { notificationId: n._id, title: n.title, message: n.message, type: n.type, link: n.link };
    if (role === "qao") emitToQaos(emitEvent, payload);
    else if (role === "student") emitToStudent(socketUserId || userId, emitEvent, payload);
    else emitToTeacher(socketUserId || userId, emitEvent, payload);
  }
  return n;
}

// ─── Notify a single teacher (persistent + socket) ──────────────────────────

export async function notifyTeacher({
  teacherId,
  title = "",
  message,
  type = "info",
  link = null,
  emitEvent = "notification:new",
}) {
  const n = await Notification.create({
    userId: teacherId,
    role: "teacher",
    title: safeTitle(title),
    message: safeMessage(message),
    type: safeType(type),
    link: link || null,
  });
  if (emitEvent) {
    emitToTeacher(teacherId, emitEvent, {
      notificationId: n._id,
      title: n.title,
      message: n.message,
      type: n.type,
      link: n.link,
    });
  }
  return n;
}

// ─── Notify a single student (persistent + socket) ──────────────────────────

export async function notifyStudent({
  studentId,
  title = "",
  message,
  type = "info",
  link = null,
  emitEvent = "notification:new",
}) {
  const n = await Notification.create({
    userId: studentId,
    role: "student",
    title: safeTitle(title),
    message: safeMessage(message),
    type: safeType(type),
    link: link || null,
  });
  if (emitEvent) {
    emitToStudent(studentId, emitEvent, {
      notificationId: n._id,
      title: n.title,
      message: n.message,
      type: n.type,
      link: n.link,
    });
  }
  return n;
}

// ─── Notify many students (persistent + socket) ─────────────────────────────

export async function notifyStudents({
  studentIds,
  title = "",
  message,
  type = "info",
  link = null,
  emitEvent = "notification:new",
}) {
  if (!Array.isArray(studentIds) || !studentIds.length) return [];
  const docs = await Notification.insertMany(
    studentIds.map((id) => ({
      userId: id,
      role: "student",
      title: safeTitle(title),
      message: safeMessage(message),
      type: safeType(type),
      link: link || null,
    }))
  );
  if (emitEvent) {
    // emitToStudents() invokes the mapper with the *student id*, so look the doc
    // up by userId (indexing the returned array by the id string is undefined).
    emitToStudents(studentIds, emitEvent, (studentId) => {
      const doc = docs.find((d) => String(d.userId) === String(studentId));
      return {
        notificationId: doc?._id || "",
        title: doc?.title || safeTitle(title),
        message: doc?.message || safeMessage(message),
        type: doc?.type || safeType(type),
        link: doc?.link || null,
      };
    });
  }
  const ids = docs.map((d) => d._id);
  return Notification.find({ _id: { $in: ids } }).sort({ createdAt: -1 }).lean();
}

// ── Broadcast to ALL teachers (single shared doc + "teachers" room) ───────

export async function notifyAllTeachers({
  title = "",
  message,
  type = "info",
  emitEvent = "notification:new",
}) {
  const doc = await Notification.create({
    userId: null,
    role: "teacher",
    title: safeTitle(title),
    message: safeMessage(message),
    type: safeType(type),
    link: null,
  });
  if (emitEvent) {
    emitToAllTeachers(emitEvent, {
      notificationId: doc._id,
      title: doc.title,
      message: doc.message,
      type: doc.type,
      link: doc.link,
    });
  }
  return doc;
}

// ── Broadcast to ALL QAO users (single shared doc + "qaos" room) ────────────

export async function notifyAllQaos({ title = "", message, type = "alert", emitEvent = null }) {
  const doc = await Notification.create({
    userId: null,
    role: "qao",
    title: safeTitle(title),
    message: safeMessage(message),
    type: safeType(type),
  });
  if (emitEvent) {
    emitToQaos(emitEvent, { notificationId: doc._id, title: doc.title, message: doc.message, type: doc.type });
  }
  return doc;
}

// ── Query helpers (generic, for teacher/student/admin) ──────────────────────

/** List notifications for a specific user (any role). */
export async function listForUser({ userId, role, limit = 50 } = {}) {
  const query = {};
  if (userId) query.userId = userId;
  if (role) query.role = role;
  return Notification.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean();
}

/** Mark a notification as read (scoped to userId for safety). */
export async function markRead({ notificationId, userId }) {
  const n = await Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    { read: true },
    { new: true }
  );
  if (!n) throw new Error("Notification not found");
  return n;
}

/** Mark all notifications as read for a user. */
export async function markAllRead({ userId, role }) {
  const query = { userId };
  if (role) query.role = role;
  await Notification.updateMany(query, { read: true });
  return { ok: true };
}

/** Unread count for a user. */
export async function unreadCount({ userId, role } = {}) {
  const query = { userId, read: false };
  if (role) query.role = role;
  return Notification.countDocuments(query);
}

/**
 * Delete ONE notification (scoped to its owner, so users can only clear their own).
 * Backs the "dismiss / cancel" action on the student + teacher notification bells.
 */
export async function deleteNotification({ notificationId, userId }) {
  const n = await Notification.findOneAndDelete({ _id: notificationId, userId });
  if (!n) throw new Error("Notification not found");
  return n;
}

/**
 * Clear a user's notifications. `onlyRead` (default true) keeps unread ones, so a
 * "clear old notifications" action never silently discards something new.
 * Pass { onlyRead: false } to wipe everything.
 */
export async function clearNotifications({ userId, role, onlyRead = true } = {}) {
  const query = { userId };
  if (role) query.role = role;
  if (onlyRead) query.read = true;
  const { deletedCount } = await Notification.deleteMany(query);
  return { deleted: deletedCount || 0, onlyRead };
}

// ── QAO helpers. `role: "qao"` also matches role-broadcast docs (userId null).

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