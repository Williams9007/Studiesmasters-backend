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
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectDB from "./config/db.js";

// Routes
import studentRoutes from "./routes/studentRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import adminRoutes, { setSocketIO as setAdminSocket } from "./routes/adminRoutes.js";
import subjectRoutes from "./routes/subjectRoutes.js";
import qaoRoutes from "./routes/qaoRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import classGroupRoutes from "./routes/classGroupRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import resourceRoutes from "./routes/resourceRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import { setSocketIO as setBroadcastSocket } from "./Controllers/broadcasting.js";

// ==========================
// VALIDATE ENV VARIABLES
// ==========================
const requiredEnv = ["MONGO_USER", "MONGO_PASSWORD", "MONGO_HOST", "MONGO_DB_NAME", "JWT_SECRET"];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`❌ Missing required env variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}

// Build MONGO_URI from parts for backward compatibility with existing code
process.env.MONGO_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@${process.env.MONGO_HOST}/${encodeURIComponent(process.env.MONGO_DB_NAME)}`;

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
  "http://localhost:5174",
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
// SECURITY MIDDLEWARE
// ==========================
app.use(helmet());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many login attempts, please try again after 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

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
app.use("/api/students", authRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/teachers", authRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/subjects", subjectRoutes);
app.use("/api/qao", qaoRoutes);
app.use("/api/class-groups", classGroupRoutes);
app.use("/api/resources", resourceRoutes);
app.use("/api/messages", messageRoutes);

app.get("/", (req, res) => {
  res.send("🚀 Studiesmasters API is running");
});

app.get("/health", (req, res) => {
  const dbState = mongoose.connection.readyState;
  const isDbConnected = dbState === 1;
  const status = isDbConnected ? "ok" : "error";

  res.status(isDbConnected ? 200 : 503).json({
    status,
    database: isDbConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
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

// Make io available in routes/controllers
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
  console.log("🔌 Socket connected:", socket.id);

  const userId = socket.handshake.query?.userId;
  if (userId) {
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    console.log("✅ User connected with ID:", userId);
  } else {
    console.log("⚠️ Socket connected without user ID");
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
const PORT = process.env.PORT
  ? isNaN(Number(process.env.PORT))
    ? process.env.PORT
    : Number(process.env.PORT)
  : 5000;

const onListenError = (error) => {
  if (error.syscall !== "listen") {
    throw error;
  }

  const bind = typeof PORT === "string" ? `Pipe ${PORT}` : `Port ${PORT}`;
  switch (error.code) {
    case "EACCES":
      console.error(`❌ ${bind} requires elevated privileges`);
      process.exit(1);
      break;
    case "EADDRINUSE":
      console.error(`❌ ${bind} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
};

httpServer.on("error", onListenError);

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
