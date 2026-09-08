// Reproduce admin dashboard GET handlers to find the 500 source.
import "dotenv/config";
import connectDB from "../config/db.js";
import { listMappings, queueSnapshot, syncOverview, listWarnings, provisionStatus } from "../services/moodle/index.js";

await connectDB();
const tests = { listMappings, queueSnapshot, syncOverview, listWarnings, provisionStatus };
for (const [name, fn] of Object.entries(tests)) {
  try {
    const r = await fn({ limit: 50 });
    console.log(`OK   ${name}`, typeof r === "object" ? Object.keys(r).slice(0, 5) : typeof r);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  }
}
const mongoose = (await import("mongoose")).default;
await mongoose.disconnect();
process.exit(0);
