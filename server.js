// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./config/db.js";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";

// Routes
import studentRoutes from "./routes/studentRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import adminRoutes, { setSocketIO } from "./routes/adminRoutes.js";

dotenv.config();
connectDB();

const app = express();

// ------------------ CORS ------------------
const allowedOrigins = [
  "http://localhost:5173",
  "https://studiesmasters-frontend.onrender.com",
  "https://studiesmasters.com",
  "https://williams9007.github.io",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (!allowedOrigins.includes(origin))
        return callback(new Error(`CORS policy: ${origin} is not allowed`), false);
      return callback(null, true);
    },
    credentials: true,
  })
);

// ------------------ Body parsing ------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------ Static files ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ------------------ Routes ------------------
app.use("/api/students", studentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);

// ------------------ Default route ------------------
app.get("/", (req, res) => res.send("EduConnect API is running"));

// ------------------ Global error handler ------------------
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).json({ success: false, message: err.message });
});

// ------------------ HTTP & Socket.IO ------------------
const PORT = process.env.PORT || 5000;
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, credentials: true },
});

// Make io available in adminRoutes for sending broadcasts
setSocketIO(io);
app.set("io", io);

// ------------------ Socket.IO connections ------------------
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Students send studentId as query
  const studentId = socket.handshake.query.studentId;
  if (studentId) {
    socket.join(studentId);
    console.log(`Student ${studentId} joined room ${studentId}`);
  }

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// ------------------ Broadcast helper functions ------------------
// Send to a single student
export const sendBroadcastToStudent = (studentId, message) => {
  io.to(studentId).emit("new-broadcast", message);
};

// Send to all students
export const broadcastToAllStudents = async (studentsIds = [], message) => {
  if (studentsIds.length > 0) {
    studentsIds.forEach((id) => io.to(id).emit("new-broadcast", message));
  } else {
    io.emit("new-broadcast", message);
  }
};

// ------------------ Start server ------------------
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
