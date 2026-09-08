// Inspect recent failed sync jobs / audits for the real error text.
import "dotenv/config";
import mongoose from "mongoose";

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

const jobs = await db.collection("syncjobs").find({ status: { $in: ["failed", "retry"] } }).sort({ updatedAt: -1 }).limit(3).toArray();
console.log("JOBS:", JSON.stringify(jobs.map((x) => ({ type: x.type, status: x.status, error: x.lastError || x.error, attempts: x.attempts })), null, 2));

const audits = await db.collection("moodleauditlogs").find({}).sort({ createdAt: -1 }).limit(6).toArray();
console.log("AUDITS:", JSON.stringify(audits.map((x) => ({ action: x.action, outcome: x.outcome, failure: x.failure, detail: x.detail })), null, 2));

await mongoose.disconnect();
