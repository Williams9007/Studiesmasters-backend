// One-off CLI: drains the Moodle sync queue (processes pending SyncJobs).
// Usage: node scripts/run-worker-once.mjs
import "dotenv/config";
import connectDB from "../config/db.js";
import { processQueueBatch } from "../services/moodle/worker.js";

await connectDB();
try {
  let processed = 0;
  // Loop until the queue is empty (batches of 10).
  for (let round = 0; round < 50; round += 1) {
    const n = await processQueueBatch({ max: 10 });
    processed += n;
    if (n === 0) break;
  }
  console.log(`WORKER DONE: processed ${processed} jobs`);
} catch (err) {
  console.error("WORKER FAILED:", err.message);
  process.exitCode = 1;
} finally {
  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect();
}
