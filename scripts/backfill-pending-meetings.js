// scripts/backfill-pending-meetings.js
//
// CLI for POST /api/admin/sessions/backfill-meetings: regenerates the Google
// Meet link for every scheduled/live ClassSession saved with
// meetingStatus != "ready" and an EMPTY meetingLink (the exact state sessions
// end up in while Google's refresh grant is dead / the account is
// disconnected). Each regenerated meeting is also re-pushed to Moodle by
// regenerateMeeting().
//
// Run AFTER reconnecting the Google account:
//   node scripts/backfill-pending-meetings.js --dry-run   # report only
//   node scripts/backfill-pending-meetings.js             # regenerate + push
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import ClassSession from "../models/ClassSession.js";
import { getAccessTokenStatus } from "../services/google/token.service.js";
import { backfillPendingMeetings } from "../services/qao/scheduling.service.js";

const DRY_RUN = process.argv.includes("--dry-run");
const line = (s = "") => console.log(s);

if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not defined. Add it to your .env file.");
  process.exit(1);
}
await mongoose.connect(process.env.MONGO_URI);
try {
  // 1) Refuse to run while Google is still broken, so we fail fast with a
  //    clear reason instead of leaving sessions half-updated.
  const svcEmail = "virtualclass@studiesmasters.com";
  const { token, error } = await getAccessTokenStatus({ email: svcEmail });
  line(`Google token: ${token ? "OK" : `UNUSABLE - ${error}`}`);
  if (!token) {
    line(`Reconnect first: GET /api/google/oauth/start (authorize ${svcEmail}), then re-run.`);
    process.exitCode = 1;
  } else {
    // 2) Sessions currently missing a link.
    const pending = await ClassSession.find({
      status: { $in: ["scheduled", "live"] },
      meetingStatus: { $ne: "ready" },
      $or: [{ meetingLink: "" }, { meetingLink: null }, { meetingLink: { $exists: false } }],
    })
      .select("date startTime endTime meetingStatus")
      .sort({ date: 1, startTime: 1 })
      .lean();
    line(`Sessions missing a Meet link: ${pending.length}`);
    for (const s of pending) {
      const d = s.date instanceof Date ? s.date.toISOString().slice(0, 10) : "?";
      line(`  ${d} ${s.startTime}-${s.endTime}  status=${s.meetingStatus}`);
    }

    if (DRY_RUN) {
      line("\n--dry-run: nothing was changed.");
    } else if (pending.length) {
      const result = await backfillPendingMeetings({ limit: 500, actor: "backfill-pending-meetings" });
      line(`\nBackfill result: ready=${result.ready} stillPending=${result.stillPending} failed=${result.failed}`);
      for (const e of result.errors || []) line(`  error ${e.sessionId}: ${e.error}`);
      line("Regenerated links were re-pushed to Moodle automatically.");
    } else {
      line("Nothing to do.");
    }
  }
} finally {
  await mongoose.disconnect();
}
