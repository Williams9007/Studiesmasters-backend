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
export function emitToStudents(studentIds, event, payloadOrMapper = {}) {
  if (!io || !Array.isArray(studentIds)) return;
  for (const id of studentIds) {
    if (id) {
      let payload;
      if (typeof payloadOrMapper === "function") {
        payload = payloadOrMapper(id);
      } else {
        payload = payloadOrMapper;
      }
      io.to(`student:${id}`).emit(event, payload);
    }
  }
}

// Emit to all connected teachers via the "teachers" broadcast room.
// Note: this only reaches *currently connected* sockets — use notifyTeacher()
// in a loop (with the Notification model) for durable, offline-capable delivery.
export function emitToAllTeachers(event, payload = {}) {
  if (io) io.to("teachers").emit(event, payload);
}

// Emit to the shared admin room ("admins") — every connected admin dashboard
// joins it (server.js auto-joins on connect when role=admin, or via "admin-join").
export function emitToAdmin(event, payload = {}) {
  if (io) io.to("admins").emit(event, payload);
}

// Emit to one admin's private room (admin:{id}).
export function emitToAdmins(adminId, event, payload = {}) {
  if (io && adminId) io.to(`admin:${adminId}`).emit(event, payload);
}
