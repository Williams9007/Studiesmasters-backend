// src/routes/classGroupRoutes.js
import { Router } from "express";
import { adminAuth } from "../middleware/adminAuth.js";
import {
  generateGroups,
  listGroups,
  } from "../Controllers/classGroupController.js";

const router = Router();

// These endpoints create groups (which embed student refs) and list groups.
// They are admin tooling: they MUST NOT be callable without authentication.
router.use(adminAuth);

/**
 * @route POST /api/class-groups/generate
 * @desc Create groups & optionally assign a teacher.
 */
router.post("/generate", generateGroups);

/**
 * @route GET /api/class-groups
 * @desc Get all groups for a specific curriculum.
 */
router.get("/", listGroups);

export default router;
