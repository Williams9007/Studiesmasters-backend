// Socket.io helper for QAO role rooms. server.js/socket.js inject the io
// instance here (same pattern as Controllers/broadcasting.js setSocketIO).
// QAO events are emitted ONLY to the "qaos" room (or a specific qao room) so
// student-targeted payloads never reach tutor managers and vice versa.

let io = null;

export const setSocketIO = (socketInstance) => {
  io = socketInstance;
};

export function emitToQaos(event, payload = {}) {
  if (io) io.to("qaos").emit(event, payload);
}

export function emitToTeacher(teacherId, event, payload = {}) {
  if (io && teacherId) io.to(`teacher:${teacherId}`).emit(event, payload);
}
// Emit to a specific student's private room (student:{id}) — never global.
export function emitToStudent(studentId, event, payload = {}) {
  if (io && studentId) io.to(`student:${studentId}`).emit(event, payload);
}

// Emit to many students' private rooms.
export function emitToStudents(studentIds, event, payload = {}) {
  if (!io || !Array.isArray(studentIds)) return;
  for (const id of studentIds) if (id) io.to(`student:${id}`).emit(event, payload);
}

// Emit to a specific admin's room (admin:{id}). A shared "admins" broadcast
// room is intentionally NOT used because the platform forbids global broadcasts.
export function emitToAdmin(adminId, event, payload = {}) {
  if (io && adminId) io.to(`admin:${adminId}`).emit(event, payload);
}
