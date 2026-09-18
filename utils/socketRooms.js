// utils/socketRooms.js
//
// Single definition of the Socket.IO role rooms used by every server-side
// notification emit (see services/qao/notify.js):
//
//   student:{id}  - one student        (emitToStudent / emitToStudents)
//   teacher:{id}  - one teacher        (emitToTeacher)
//   teachers      - every teacher      (emitToAllTeachers)
//   qao:{id}      - one tutor manager  |
//   qaos          - every tutor manager
//   admins        - every admin        (emitToAdmin)
//   admin:{id}    - one admin          (emitToAdmins)
//
// Extracted from server.js so the routing contract can be unit-tested without
// booting HTTP/Mongo (see scripts/notify-self-test.js).

export const ROLE_ROOMS = ["student", "teacher", "qao", "admin"];

/**
 * Join the room(s) for one role/user pair.
 * @param {{ join: (room: string) => any }} socket Socket.IO socket
 * @param {string} role "student" | "teacher" | "qao" | "admin"
 * @param {string|undefined|null} userId the user's Mongo _id
 * @returns {string[]} the rooms joined
 */
export function joinRoleRooms(socket, role, userId) {
  const id = userId ? String(userId) : "";
  if (!socket || !id || !ROLE_ROOMS.includes(role)) return [];

  switch (role) {
    case "student":
      // The bare `{id}` room is kept for legacy student-targeted broadcasts
      // (routes/adminRoutes.js emits `io.to(studentId)`).
      socket.join(`student:${id}`);
      socket.join(id);
      return [`student:${id}`, id];
    case "teacher":
      socket.join("teachers");
      socket.join(`teacher:${id}`);
      return ["teachers", `teacher:${id}`];
    case "qao":
      socket.join("qaos");
      socket.join(`qao:${id}`);
      return ["qaos", `qao:${id}`];
    case "admin":
      socket.join("admins");
      socket.join(`admin:${id}`);
      return ["admins", `admin:${id}`];
    default:
      return [];
  }
}

/** Parse the handshake into { userId, role } (auth payload wins over query). */
export function handshakeIdentity(socket) {
  const query = socket?.handshake?.query || {};
  const auth = socket?.handshake?.auth || {};
  const userId = auth.userId || query.userId || null;
  const role = String(auth.role || query.role || "").toLowerCase();
  return { userId, role };
}

export default { joinRoleRooms, handshakeIdentity, ROLE_ROOMS };