// One-off CLI: enqueues + runs a bulk student->Moodle sync.
// Usage: node scripts/run-sync-all.mjs
import "dotenv/config";
import connectDB from "../config/db.js";
import { syncAllStudents } from "../services/moodle/index.js";

await connectDB();
try {
  const result = await syncAllStudents({ req: null });
  console.log("SYNC ALL RESULT:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("SYNC ALL FAILED:", err.message);
  process.exitCode = 1;
} finally {
  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect();
}
