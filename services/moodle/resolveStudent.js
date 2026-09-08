// services/moodle/resolveStudent.js
//
// Resolve a Student by EITHER its Mongo `_id` OR its public `userId`
// (e.g. "SM-ST-MRXHI76K-A2A557E2"). The admin dashboard lets staff paste either
// identifier, so every student-facing Moodle service/route must accept both.
// Without this, pasting a userId into `Student.findById()` throws a Mongoose
// CastError (which surfaced as 502 "Moodle sync failed." / 500 "Access preview
// failed.").

import mongoose from "mongoose";
import Student from "../../models/Student.js";

export async function findStudent(idOrUserId) {
  const key = String(idOrUserId ?? "").trim();
  if (!key) return null;

  // If it looks like a valid Mongo ObjectId, try by _id first (fast path).
  if (mongoose.Types.ObjectId.isValid(key)) {
    const byId = await Student.findById(key);
    if (byId) return byId;
  }

  // Otherwise (or if that _id doesn't exist) match on the public userId,
  // e.g. "SM-ST-...".
  if (key.length > 0 && /^SM-/i.test(key)) {
    return Student.findOne({ userId: key });
  }

  return null;
}

export default findStudent;