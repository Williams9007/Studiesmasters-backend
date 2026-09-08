// Reset all syncProfile jobs to pending so the worker retries immediately.
import "dotenv/config";
import connectDB from "../config/db.js";
import SyncJob from "../models/SyncJob.js";

await connectDB();
const r = await SyncJob.updateMany({ type: "syncProfile" }, { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
console.log("RESET:", r.modifiedCount);
const mongoose = (await import("mongoose")).default;
await mongoose.disconnect();
process.exit(0);
