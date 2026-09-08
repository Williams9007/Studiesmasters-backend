// Sync the newly registered student (Lydia) into Moodle.
import "dotenv/config";
import connectDB from "../config/db.js";
import { syncProfile } from "../services/moodle/syncProfile.js";
import MoodleLink from "../models/MoodleLink.js";

await connectDB();
const id = "6a98b9f133e1f9252c1f5993";
const r = await syncProfile({ id, req: null });
console.log("SYNC RESULT:", JSON.stringify(r, null, 1));
const link = await MoodleLink.findOne({ studentRef: id }).lean();
console.log("LINK:", { moodleUserId: link?.moodleUserId, enrolled: link?.enrolledCourseIds });
const mongoose = (await import("mongoose")).default;
await mongoose.disconnect();
process.exit(0);
