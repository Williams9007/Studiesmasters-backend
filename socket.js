// backend/socket.js
import { Server } from "socket.io";

/**
 * Initialize Socket.IO with HTTP server
 * @param {http.Server} server - Node HTTP server
 */
export const initSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "*", // Replace "*" with your frontend URL in production
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("⚡ New client connected:", socket.id);

    // Join student-specific room
    socket.on("student-join", (studentId) => {
      console.log("Student joined room:", studentId);
      socket.join(studentId); // Room for that student
socket.join("student:" + studentId); // canonical prefix room (student:{id})
    });

    // Join admin room
    socket.on("admin-join", (adminId) => {
      console.log("Admin joined room:", adminId);
      socket.join("admins"); // single room for all admins

if (adminId) socket.join("admin:" + adminId); // per-admin room (admin:{id})
    });

    // Tutor Manager (QAO) role rooms: used for QAO-only operational alerts
    // (group:unassigned, class:upcoming, leave:request:new, schedule:conflict).
    // QAO sockets must never receive student-related payloads.
    socket.on("qao-join", (qaoUserId) => {
      socket.join("qaos");
      if (qaoUserId) socket.join("qao:" + qaoUserId);
    });

    // Teacher role room
    socket.on("teacher-join", (teacherId) => {
      socket.join("teachers");
      if (teacherId) socket.join("teacher:" + teacherId);
    });

    // Broadcast from admin to students
    socket.on("broadcast-to-students", (broadcast) => {
      console.log("📢 Broadcast to students:", broadcast);
      io.emit("new-broadcast", broadcast); // send to all connected clients
    });

    // Broadcast from admin to a specific student
    socket.on("broadcast-to-student", ({ studentId, broadcast }) => {
      console.log("📢 Broadcast to student " + studentId + ":", broadcast);
      io.to(studentId).emit("new-broadcast", broadcast);
    });

    socket.on("disconnect", () => {
      console.log("❌ Client disconnected:", socket.id);
    });
  });

  return io;
};
