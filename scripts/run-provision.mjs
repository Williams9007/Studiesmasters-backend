// One-off CLI: runs Moodle structure provisioning (categories + courses + CourseMappings).
// Usage: node scripts/run-provision.mjs
import "dotenv/config";
import connectDB from "../config/db.js";
import { provisionStructure } from "../services/moodle/index.js";

await connectDB();
try {
  const result = await provisionStructure({});
  console.log("PROVISION RESULT:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("PROVISION FAILED:", err.message);
  process.exitCode = 1;
} finally {
  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect();
}
