// src/routes/classGroupRoutes.js
import { Router } from "express";
import {
  generateGroups,
  listGroups,
} from "../controllers/classGroupController.js";

const router = Router();

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
