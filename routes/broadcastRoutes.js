import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { sendBroadcast } from "../Controllers/broadcasting.js";
import { adminAuth } from "../middleware/adminAuth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the uploads/broadcasts directory exists
const broadcastUploadDir = path.join(__dirname, "../uploads/broadcasts/");
if (!fs.existsSync(broadcastUploadDir)) {
  fs.mkdirSync(broadcastUploadDir, { recursive: true });
}

// Multer setup for broadcast attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, broadcastUploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

const router = express.Router();

// Admin sends broadcast
router.post("/", adminAuth, upload.single("attachment"), sendBroadcast);
router.post("/send", adminAuth, upload.single("attachment"), sendBroadcast);

export default router;
