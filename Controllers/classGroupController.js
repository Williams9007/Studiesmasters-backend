// src/controllers/classGroupController.js
import { createGroupsForCurriculum } from "../services/classGroupService.js";
import ClassGroup from "../models/ClassGroup.js";
import Teacher from "../models/teacher.js";

/**
 * @route POST /api/class-groups/generate
 * @desc Create groups for a curriculum (5 or 10 per group) and optionally assign a teacher.
 *       Body: { curriculum: string, groupSize?: number, teacherId?: string }
 */
export async function generateGroups(req, res) {
  const { curriculum, groupSize = 5, teacherId } = req.body;

  try {
    if (![5, 10].includes(groupSize))
      return res.status(400).json({ error: "groupSize must be 5 or 10" });

    // 1️⃣ Run the service – creates the groups & saves them
    const groups = await createGroupsForCurriculum(curriculum, groupSize, teacherId);

    // 2️⃣ Populate each group with the teacher name (if any)
    const populated = await Promise.all(
      groups.map((g) => ClassGroup.findById(g._id).populate("teacher"))
    );

    return res.status(201).json(populated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * @route GET /api/class-groups
 * @desc List all groups for a given curriculum (used by the admin UI)
 *       Query‑param: curriculum=Mathematics%20101
 */
export async function listGroups(req, res) {
  const { curriculum } = req.query;
  if (!curriculum) return res.status(400).json({ error: "curriculum required" });

  try {
    const groups = await ClassGroup.find({ curriculum })
      .populate("teacher")
      .sort({ createdAt: -1 });
    return res.json(groups);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}