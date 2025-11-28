import express from "express";
import { getSubjectsByPackage } from "../controllers/subjectController.js";

const router = express.Router();

// Route to fetch subjects by package and optional grade
router.get("/by-package/:package", getSubjectsByPackage);

export default router;
