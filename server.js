// ==========================
// ENV MUST LOAD FIRST
// ==========================
import dotenv from "dotenv";
dotenv.config();

// ==========================
// GLOBAL UNHANDLED REJECTION HANDLER
// Prevents server crash on unhandled promise rejections
// ==========================
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ UNHANDLED PROMISE REJECTION:", reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
  // Alert the admin about the unhandled rejection
  sendSystemAlert({
    title: "⚠️ Unhandled Promise Rejection",
    message: `An unhandled promise rejection occurred:\n\n${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
    key: `unhandled-rejection-${Date.now()}`,
    severity: "WARNING",
  });
});

process.on("uncaughtException", (error) => {
  console.error("❌ UNCAUGHT EXCEPTION:", error.message);
  console.error(error.stack);
  // Alert the admin about the uncaught exception
  sendSystemAlert({
    title: "🚨 Uncaught Exception",
    message: `An uncaught exception occurred:\n\n${error.stack || error.message}`,
    key: `uncaught-exception-${Date.now()}`,
    severity: "CRITICAL",
  });
  // Don't exit immediately - let the process continue if possible
  // The process will exit naturally if the error is fatal
});

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
import { init as initSystemGuard } from "./services/systemGuard.js";
import { initSystemAlerts, sendSystemAlert } from "./services/systemAlertService.js";
import systemGuardRoutes from "./routes/systemGuardRoutes.js";

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
import broadcastRoutes from "./routes/broadcastRoutes.js";
import { setSocketIO as setBroadcastSocket } from "./Controllers/broadcasting.js";
import pushNotificationRoutes from "./routes/pushNotificationRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import moodleRoutes from "./routes/moodleRoutes.js";

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
// MOODLE SSO CONFIG (optional)
// ==========================
// These are required only when the StudiesMasters -> Moodle SSO feature is used.
// They are NOT required for normal platform operation, so a missing value logs a
// warning instead of crashing the server. (getSecret() in moodleRoutes.js still
// throws lazily if you hit /api/moodle/sso without a secret.)
const moodleSsoEnv = ["MOODLE_SSO_SECRET", "MOODLE_BASE_URL", "MOODLE_SSO_PATH"];
const missingMoodleEnv = moodleSsoEnv.filter((k) => !process.env[k]);
if (missingMoodleEnv.length) {
  console.warn(`⚠️  Moodle SSO env vars missing (${missingMoodleEnv.join(", ")}). ` +
    "The /api/moodle/sso endpoint will fail until these are set to match the Moodle plugin config.");
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
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:5174",
  // The System Guard page is served by this API and makes authenticated API calls itself.
  "https://studiesmasters-backend.onrender.com",
  "https://studiesmasters-frontend.onrender.com",
  "https://studiesmasters.com",
  "https://www.studiesmasters.com",
  "https://williams9007.github.io",
  "https://studiesmasters.netlify.app",
  "https://studiesmasters.vercel.app",
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
app.use(helmet({
  contentSecurityPolicy: false, // Disabled because system guard uses inline scripts
  crossOriginEmbedderPolicy: false,
  frameguard: false, // Allow system-guard.html to be embedded in the frontend admin dashboard iframe
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  noSniff: true,
  xssFilter: true,
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many login attempts, please try again after 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Global API rate limiter (applied to all /api/ routes)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// ==========================
// BODY PARSER (with size limits)
// ==========================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ==========================
// STATIC FILES
// ==========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ==========================
// SYSTEM GUARD DASHBOARD (served without helmet CSP to allow inline scripts)
// ==========================
app.get("/system-guard.html", (req, res) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' *; " +
    "img-src 'self' data:; " +
    "font-src 'self' data:; " +
    "frame-ancestors 'self' https://studiesmasters-frontend.onrender.com https://studiesmasters.com http://localhost:5173 http://localhost:5174;"
  );
  res.sendFile(path.join(__dirname, "public", "system-guard.html"));
});

// ==========================
// FAVICON (prevent 404)
// ==========================
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

// ==========================
// SYSTEM GUARD (Firewall + Self-Diagnosis + Self-Healing)
// ==========================
initSystemGuard(app);

// ==========================
// SYSTEM ALERT SERVICE (email + push alerts on downtime/errors)
// ==========================
initSystemAlerts();

// ==========================
// SECURE SYSTEM GUARD API ROUTES (protected by admin auth)
// ==========================
app.use("/api/system-guard", systemGuardRoutes);

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
app.use("/api/admin/broadcasts", broadcastRoutes);
app.use("/api/notifications", pushNotificationRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/moodle", moodleRoutes);

app.get("/", (req, res) => {
  res.send("🚀 Studiesmasters API is running");
});

// Handle POST to root (used by the landing page ChatBotWidget contact form)
app.post("/", async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: "Name, email, and message are required" });
    }
    // Forward to the contact controller logic
    const { sendContactMessage } = await import("./Controllers/contactController.js");
    return sendContactMessage(req, res);
  } catch (error) {
    console.error("❌ Root POST error:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
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

    // ------------------ Moodle module bootstrap (optional) --------------
    // Auto-sync: enqueue profile/enrollment sync when students change.
    if (String(process.env.MOODLE_AUTO_SYNC || "false") === "true") {
      try {
        const Student = (await import("./models/Student.js")).default;
        const studentAutosyncPlugin = (await import("./services/moodle/autosync.js")).default;
        Student.schema.plugin(studentAutosyncPlugin);
        console.log("✅ Moodle auto-sync plugin attached to Student schema.");
      } catch (e) {
        console.warn("⚠️  Could not attach Moodle autosync plugin:", e.message);
      }
    }

    // Queue worker: process durable sync jobs.
    const workerEnabled = String(process.env.MOODLE_WORKER_ENABLED || process.env.MOODLE_WS_ENABLED || "false") === "true";
    if (workerEnabled) {
      try {
        const moodleFacade = await import("./services/moodle/index.js");
        moodleFacade.startWorker({ enabled: true, intervalMs: 2000 });
      } catch (e) {
        console.warn("⚠️  Could not start Moodle worker:", e.message);
      }
    }

    // Periodic reconciliation (check + repair MongoDB <-> Moodle).
    if (String(process.env.MOODLE_RECONCILIATION_ENABLED || "false") === "true") {
      try {
        const { runReconciliation } = await import("./services/moodle/reconciliation.js");
        const intervalMs = parseInt(process.env.MOODLE_RECONCILIATION_INTERVAL_MS || "3600000", 10);
        const runNow = async () => { try { await runReconciliation(); } catch (e) { console.warn("Reconciliation run failed:", e.message); } };
        if (String(process.env.MOODLE_RECONCILIATION_ON_START || "false") === "true") runNow();
        setInterval(runNow, intervalMs);
        console.log(`✅ Moodle reconciliation scheduled every ${intervalMs}ms.`);
      } catch (e) {
        console.warn("⚠️  Could not schedule Moodle reconciliation:", e.message);
      }
    }

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();