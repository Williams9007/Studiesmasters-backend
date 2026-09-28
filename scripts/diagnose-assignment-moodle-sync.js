// scripts/diagnose-assignment-moodle-sync.js
//
// READ-ONLY live diagnostic for the two reported problems:
//   1. "Assigned class / assigned subject" not showing on the main website.
//   2. Scheduled classes + Google Meet links not reaching Moodle.
//
// It connects to the configured MongoDB (same config as the server) and reports
// the exact counts/samples that explain each symptom. It NEVER writes anything —
// safe to run against production.
//
// Run: node scripts/diagnose-assignment-moodle-sync.js
import dotenv from "dotenv";
dotenv.config();

import connectDB from "../config/db.js";
import mongoose from "mongoose";
import Teacher from "../models/teacher.js";
import Subject from "../models/Subject.js";
import TeacherAssignment from "../models/TeacherAssignment.js";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";
import CourseMapping from "../models/CourseMapping.js";
import GoogleToken from "../models/GoogleToken.js";
import { config } from "../services/moodle/config.js";

const line = (s = "") => console.log(s);
const head = (s) => line(`\n=== ${s} ===`);

async function main() {
  await connectDB();
  line("Connected to MongoDB.\n");

  // ---------------------------------------------------------------- Moodle cfg
  head("Moodle configuration");
  line(`  enabled .......... ${config.enabled}`);
  line(`  wsEnabled ........ ${config.wsEnabled}`);
  line(`  dryRun ........... ${config.dryRun}  ${config.dryRun ? "<-- pushes are SIMULATED, nothing reaches Moodle" : ""}`);
  line(`  wsToken set ...... ${Boolean(config.wsToken)}`);
  line(`  baseUrl .......... ${config.baseUrl || "(unset)"}`);

  // ------------------------------------------------------------- Google state
  head("Google Meet configuration (why links were empty)");
  line(`  GOOGLE_ALLOW_MOCK = ${process.env.GOOGLE_ALLOW_MOCK || "(unset, defaults true)"}`);
  const svcEmail = "virtualclass@studiesmasters.com";
  const token = await GoogleToken.findOne({ provider: "google", email: svcEmail }).lean();
  line(`  account .......... ${svcEmail}`);
  line(`  connected ........ ${Boolean(token?.encryptedRefreshToken)}  ${token?.encryptedRefreshToken ? "" : "<-- NO refresh token: real Meet links cannot be minted"}`);
  if (token?.expiresAt) line(`  access expires ... ${new Date(token.expiresAt).toISOString()}`);

  // ------------------------------------------------------ assigned subjects
  head("1) Assigned subjects on the main website");
  const teachers = await Teacher.find({})
    .select("fullName name email userId curriculum subjectsTeaching")
    .populate("subjectsTeaching", "name grade package")
    .lean();
  const withSubjects = teachers.filter((t) => (t.subjectsTeaching || []).length > 0);
  const dangling = teachers.filter((t) => (t.subjectsTeaching || []).some((s) => !s || !s.name));
  line(`  teachers ................. ${teachers.length}`);
  line(`  with a subject assigned .. ${withSubjects.length}`);
  line(`  with DANGLING refs ....... ${dangling.length}  ${dangling.length ? "<-- refs point at deleted Subjects (rendered blank before the populate fix)" : ""}`);
  for (const t of teachers.slice(0, 5)) {
    line(`    - ${t.fullName || t.name || "(no name)"}: ${(t.subjectsTeaching || []).map((s) => s?.name || "<deleted>").join(", ") || "(none)"}`);
  }

  head("Subject catalogue (what the assign modal can offer)");
  line(`  subjects in catalogue ... ${await Subject.countDocuments()}`);
  const subjects = await Subject.find({}).select("name curriculum grade package").limit(10).lean();
  subjects.forEach((s) => line(`    - ${s.name} · ${s.curriculum || "?"} · ${s.grade || "?"} · ${s.package || "?"}`));

  head("TeacherAssignment rows (Moodle course resolution for teachers)");
  const taCount = await TeacherAssignment.countDocuments();
  line(`  rows .................... ${taCount}  ${taCount === 0 ? "<-- no rows; teacher Moodle courses come only from subjectsTeaching" : ""}`);
  const taSample = await TeacherAssignment.find({}).limit(5).lean();
  taSample.forEach((a) => line(`    - ${a.subject} · ${a.curriculum} · ${a.grade} · ${a.package}`));

  // ------------------------------------------------- classes / Moodle push
  head("2) Scheduled classes -> Moodle");
  const classGroups = await ClassGroup.find()
    .select("code subject grade curriculum teacher")
    .populate("teacher", "fullName")
    .lean();
  line(`  class groups ............ ${classGroups.length}`);
  const unassignedGroups = classGroups.filter((g) => !g.teacher);
  line(`  WITHOUT a teacher ....... ${unassignedGroups.length}  ${unassignedGroups.length ? "<-- no teacher = no Moodle editing-teacher enrolment" : ""}`);

  const sessions = await ClassSession.find({})
    .select("status date startTime meetingLink meetingStatus moodleEventId moodleCourseId classGroup")
    .lean();
  const activeStatuses = ["scheduled", "live"];
  const activeSessions = sessions.filter((s) => activeStatuses.includes(s.status));
  const noLink = activeSessions.filter((s) => !s.meetingLink);
  const pending = activeSessions.filter((s) => s.meetingStatus !== "ready");
  const noEvent = activeSessions.filter((s) => !s.moodleEventId);
  line(`  sessions total .......... ${sessions.length}`);
  line(`  scheduled/live .......... ${activeSessions.length}`);
  line(`  NO meetingLink .......... ${noLink.length}  ${noLink.length ? "<-- Moodle events say \"Meeting link pending\" for these" : ""}`);
  line(`  meetingStatus != ready .. ${pending.length}`);
  line(`  no moodleEventId ........ ${noEvent.length}  ${noEvent.length ? "<-- never confirmed as pushed to Moodle" : ""}`);

  head("Why a class can miss its Moodle course event");
  const mapped = await CourseMapping.countDocuments({ enabled: true });
  line(`  enabled course mappings . ${mapped}  ${mapped === 0 ? "<-- NO mappings: classes fall back to a SITE event (or no course event)" : ""}`);
  const withCourse = new Set(sessions.filter((s) => s.moodleCourseId).map((s) => String(s.classGroup)));
  const withoutMoodleCourse = classGroups.filter((g) => !withCourse.has(String(g._id)));
  line(`  class groups with no session tied to a Moodle course ... ${withoutMoodleCourse.length}`);
  withoutMoodleCourse.slice(0, 8).forEach((g) => line(`    - ${g.code} · ${g.subject} · grade ${g.grade} · teacher ${g.teacher?.fullName || "(none)"}`));

  head("Verdict / next steps");
  if (noLink.length) line(`  Run  POST /api/admin/sessions/backfill-meetings  (admin) to mint the ${noLink.length} missing Meet link(s) and re-push them to Moodle.`);
  if (!token?.encryptedRefreshToken) line(`  Connect Google first: open  GET /api/google/oauth/start  and authorize ${svcEmail}, otherwise backfill cannot create real links.`);
  if (!config.wsEnabled || config.dryRun) line("  Moodle pushes are OFF/simulated — set MOODLE_WS_ENABLED=true, MOODLE_WS_TOKEN=<token>, MOODLE_DRY_RUN=false.");
  if (!mapped) line("  Create course mappings (Admin → Moodle → course mappings) so classes attach to real Moodle courses.");
  if (!noLink.length && config.wsEnabled && !config.dryRun && mapped) line("  Configuration looks healthy — run POST /api/admin/sessions/resync-moodle to repair any drifted events.");

  line();
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("\nDiagnostic failed:", err.message);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
