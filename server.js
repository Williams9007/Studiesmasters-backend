// ========================
//  EduConnect Server
// ========================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./config/db.js";

// ========================
//  Import All Routes
// ========================
import studentRoutes from "./routes/studentRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import subjectRoutes from "./routes/subjectRoutes.js";
import assignmentRoutes from "./routes/assignmentRoutes.js";
import qaoRoutes from "./routes/qaoRoutes.js";
import courseRoutes from "./routes/course.js";
import roleRoutes from "./routes/roleRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import classRoutes from "./routes/classRoutes.js";
import teacherClassRoutes from "./routes/teacherClassRoutes.js";
import pricingRoutes from "./routes/pricing.js";

// ========================
//  Setup
// ========================
dotenv.config();
connectDB();

const app = express();

// Render uses ESM → Fix dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========================
//  CORS (Allows Your Frontend)
// ========================
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://studiesmasters.com",
      "https://williams9007.github.io",
    ],
    methods: "GET,POST,PUT,DELETE",
    allowedHeaders: "Content-Type,Authorization",
  })
);

// ========================
//  Middleware
// ========================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploads folder (images, files)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ========================
//  Register All Routes
// ========================
app.use("/api/students", studentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/subjects", subjectRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/qao", qaoRoutes);
app.use("/api/course", courseRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/teacher-classes", teacherClassRoutes);
app.use("/api/pricing", pricingRoutes);

// ========================
//  Health Check
// ========================
app.get("/", (req, res) => {
  res.send("EduConnect API is running successfully 🚀");
});

// ========================
//  Error Handler
// ========================
app.use((err, req, res, next) => {
  console.error("🔥 SERVER ERROR:", err.stack);
  res.status(500).json({ error: err.message });
});

// ========================
//  Start Server
// ========================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
