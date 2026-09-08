// scripts/fix-moodlelink-indexes.mjs
//
// Repair the MoodleLink indexes. The old `studentRef_1` / `teacherRef_1` were
// unique+sparse, which still collides on `null` (every student link has
// teacherRef:null) -> E11000 duplicate key on the 2nd student sync.
// This drops those and recreates them as PARTIAL unique indexes on real ObjectIds.
//
// Run: node scripts/fix-moodlelink-indexes.mjs

import "dotenv/config";
import mongoose from "mongoose";
import MoodleLink from "../models/MoodleLink.js";

const uri = process.env.MONGO_URI;
if (!uri) { console.error("No MONGO_URI"); process.exit(1); }
await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

const col = mongoose.connection.db.collection("moodlelinks");

// 1) Drop the old (broken) sparse-unique indexes if present.
for (const name of ["studentRef_1", "teacherRef_1"]) {
  const exists = await col.indexExists(name);
  if (exists) {
    console.log("Dropping old index:", name);
    await col.dropIndex(name);
  } else {
    console.log("Index already absent:", name);
  }
}

// 2) Recreate as partial unique indexes (via the updated model).
console.log("Rebuilding indexes from model...");
await MoodleLink.syncIndexes();

// 3) Verify.
const idx = await col.indexes();
for (const i of idx) {
  console.log("name:", i.name, "| keys:", JSON.stringify(i.key), "| unique:", !!i.unique, "| partial:", JSON.stringify(i.partialFilterExpression || null));
}

await mongoose.disconnect();
console.log("DONE");
process.exit(0);