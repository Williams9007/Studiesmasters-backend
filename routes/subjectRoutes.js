import express from "express";
import { getSubjectsByPackage } from "../Controllers/subjectcontroller.js";

const router = express.Router();

router.get("/by-package/:package", getSubjectsByPackage);

export default router;
