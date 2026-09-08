// Force all pending/retry sync jobs due, then report them.
import "dotenv/config";
import connectDB from "../config/db.js";
import mongoose from "mongoose";

await connectDB();
const c = mongoose.connection.db;
const jobs = await c.collection("syncjobs").find({}).toArray();
for (const j of jobs) {
  console.log(j._id, j.type, j.status, "attempts:", j.attempts, "nextRunAt:", j.nextRunAt);
}
const r = await c.collection("syncjobs").updateMany(
  { status: { $in: ["pending", "retry"] } },
  { $set: { nextRunAt: new Date(Date.now() - 1000) } }
);
console.log("forced due:", r.modifiedCount);
const mongoose2 = mongoose;
await mongoose2.disconnect();
