import mongoose from "mongoose";
import Student from "../models/Student.js";
import ClassGroup from "../models/ClassGroup.js";

/**
 * Splits the students of a curriculum into groups of a given size.
 *
 * @param {string} curriculum  - The curriculum identifier (e.g., "Mathematics 101").
 * @param {number} groupSize   - Either 5 or 10 (defaults to 5).
 * @param {mongoose.Types.ObjectId|null} teacherId  - Optional teacher to host all groups.
 *
 * @returns {Promise<Array>}  The created ClassGroup documents.
 */
export async function createGroupsForCurriculum(
  curriculum,
  groupSize = 5,
  teacherId = null
) {
  if (![5, 10].includes(groupSize))
    throw new Error("Group size must be either 5 or 10");

  // 1️⃣ Find all students who are enrolled in this curriculum
  const students = await Student.find({ curriculum }).lean();

  // 2️⃣ Split into chunks
  const chunks = [];
  for (let i = 0; i < students.length; i += groupSize) {
    chunks.push(students.slice(i, i + groupSize));
  }

  // 3️⃣ Create blanket ClassGroup docs
  const createdGroups = await Promise.all(
    chunks.map(async (chunk, idx) => {
      // Randomized 5‑digit code (e.g., "G-83602")
      const code = `G-${Math.floor(10000 + Math.random() * 90000)}`;

      const group = new ClassGroup({
        code,
        curriculum,
        grade: chunk[0]?.grade ?? "Unknown",
        capacity: groupSize,
        teacher: teacherId,
        students: chunk.map((s) => s._id),
        status: "active",
      });

      return group.save();
    })
  );

  return createdGroups;
}