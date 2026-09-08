// One-off CLI: enqueues bulk teacher sync then processes pending jobs.
import "dotenv/config";
import connectDB from "../config/db.js";
import { syncAllTeachers } from "../services/moodle/index.js";

await connectDB();
try {
  const r = await syncAllTeachers();
  console.log("TEACHER SYNC RESULT:", JSON.stringify(r));
  const { processQueueBatch } = await import("../services/moodle/worker.js");
  const batch = await processQueueBatch({ max: 10 });
  console.log("WORKER BATCH:", JSON.stringify(batch));
  const batch2 = await processQueueBatch({ max: 10 });
  console.log("WORKER BATCH 2:", JSON.stringify(batch2));
} catch (e) {
  console.error("TEACHER SYNC FAILED:", e.message);
} finally {
  process.exit(0);
}
