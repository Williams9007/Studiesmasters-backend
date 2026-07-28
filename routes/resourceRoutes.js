import express from "express";
import { submitResource, getMyResources } from "../Controllers/resourceController.js";
import { verifyTeacher } from "../middleware/verifyTeacher.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { getResources, getPendingResources, reviewResource } from "../Controllers/resourceController.js";

const router = express.Router();

// Teacher submits a resource
router.post("/submit", verifyTeacher, submitResource);

// Teacher gets their own resources
router.get("/my-resources", verifyTeacher, getMyResources);

// Tutor Manager / Admin gets all resources
router.get("/all", adminAuth, getResources);

// Tutor Manager / Admin gets pending resources
router.get("/pending", adminAuth, getPendingResources);

// Tutor Manager / Admin reviews a resource
router.put("/:id/review", adminAuth, reviewResource);

export default router;