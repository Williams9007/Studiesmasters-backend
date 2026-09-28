import express from "express";
import { verifyToken } from "../middleware/auth.js";
import { assignRole } from "../Controllers/roleController.js";

const router = express.Router();

/**
 * POST /api/role/select-role
 * Body: { userId, role }
 * Purpose: Assign role to a user
 */
router.post("/select-role", verifyToken, assignRole);

export default router;
