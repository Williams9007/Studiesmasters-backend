// scripts/cleanup-test-artifacts.js
// Removes temporary class groups created by verification runs (MEETTEST-*).
// Seeded real classes (SM-TEST-*) are left alone; use `npm run seed:cleanup` to
// remove those too.
import dotenv from "dotenv";
import mongoose from "mongoose";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";

dotenv.config();

const MONGO_URI =
  process.env.MONGO_URI ||
  (process.env.MONGO_USER && process.env.MONGO_HOST
    ? "mongodb+srv://" + encodeURIComponent(process.env.MONGO_USER) + ":" + encodeURIComponent(process.env.MONGO_PASSWORD || "") + "@" + process.env.MONGO_HOST + "/" + encodeURIComponent(process.env.MONGO_DB_NAME || "test")
    : null);

await mongoose.connect(MONGO_URI);
try {
  const groups = await ClassGroup.find({ code: /^MEETTEST-/ }).select("_id code").lean();
  const ids = groups.map((g) => g._id);
  const sessions = ids.length ? await ClassSession.deleteMany({ classGroup: { $in: ids } }) : { deletedCount: 0 };
  const removed = ids.length ? await ClassGroup.deleteMany({ _id: { $in: ids } }) : { deletedCount: 0 };
  console.log(`Removed ${removed.deletedCount || 0} MEETTEST group(s) and ${sessions.deletedCount || 0} session(s):`);
  for (const g of groups) console.log(`  - ${g.code}`);
} catch (err) {
  console.error("Cleanup failed:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
