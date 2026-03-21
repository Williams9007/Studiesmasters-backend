// ==========================
// ENV MUST LOAD FIRST
// ==========================
import dotenv from "dotenv";
dotenv.config();

// ==========================
// IMPORTS
// ==========================
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import connectDB from "./config/db.js";

// Routes
import studentRoutes from "./routes/studentRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import { setSocketIO as setAdminSocket } from "./routes/adminRoutes.js";
import { setSocketIO as setBroadcastSocket } from "./controllers/broadcastController.js";



// ==========================
// VALIDATE ENV VARIABLES
// ==========================
if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI is not defined in .env");
  process.exit(1);
}

// ==========================
// APP INITIALIZATION
// ==========================
const app = express();
const httpServer = createServer(app);

// ==========================
// CORS CONFIG
// ==========================
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
      if (!allowedOrigins.includes(origin)) {
        return callback(
          new Error(`CORS policy: ${origin} is not allowed`),
          false
        );
      }
      return callback(null, true);
    },
    credentials: true,
  })
);

// ==========================
// BODY PARSER
// ==========================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================
// STATIC FILES
// ==========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ==========================
// ROUTES
// ==========================
app.use("/api/students", studentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);

app.get("/", (req, res) => {
  res.send("🚀 EduConnect API is running");
});

// ==========================
// SOCKET.IO SETUP
// ==========================
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

// Make io available in routes
// Make io available everywhere
setAdminSocket(io);
setBroadcastSocket(io);
app.set("io", io);


// ==========================
// ONLINE USERS MAP
// ==========================
const onlineUsers = new Map(); // userId -> socketId
app.set("onlineUsers", onlineUsers);

// ==========================
// SOCKET CONNECTION
// ==========================
io.on("connection", (socket) => {
  console.log("🔌 Raw socket connected:", socket.id);

  const { userId } = socket.handshake.query;

  if (userId) {
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    console.log("✅ User connected with ID:", userId);
  }

  socket.on("disconnect", () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      console.log("❌ User disconnected:", socket.userId);
    }
  });
});

// ==========================
// GLOBAL ERROR HANDLER
// ==========================
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.message);
  res.status(500).json({
    success: false,
    message: err.message,
  });
});

// ==========================
// START SERVER ONLY AFTER DB CONNECTS
// ==========================
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();
