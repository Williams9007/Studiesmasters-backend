import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";

// ===== IMPORT ALL YOUR ROUTES =====
import studentRoutes from "./routes/studentRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import subjectRoutes from "./routes/subjectRoutes.js";
import assignmentRoutes from "./routes/assignmentRoutes.js";
import qaoRoutes from "./routes/qaoRoutes.js";
import courseRoutes from "./routes/course.js";       // course.js
import roleRoutes from "./routes/roleRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import classRoutes from "./routes/classRoutes.js";
import teacherClassRoutes from "./routes/teacherClassRoutes.js";
import pricingRoutes from "./routes/pricing.js";     // pricing.js

dotenv.config();
const app = express();

// ===== MIDDLEWARE =====
app.use(cors());            // Allow cross-origin requests
app.use(express.json());    // Parse JSON bodies

// ===== DATABASE =====
connectDB();

// ===== USE ALL ROUTES =====
app.use("/api/students", studentRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/subjects", subjectRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/qao", qaoRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/teacher-class", teacherClassRoutes);
app.use("/api/pricing", pricingRoutes);

// ===== HEALTH CHECK FOR RENDER =====
app.get("/", (req, res) => {
  res.send("EduConnect API is running...");
});

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
