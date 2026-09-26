// scripts/diagnose-moodle-profile-sync.js
//
// READ-ONLY live diagnostic answering one question: is user data actually
// reaching Moodle, or is only the virtual-class path working?
//
// Virtual classes are PULL-based — the Moodle page calls /api/moodle/vclass/*
// directly, so they work regardless of this configuration. User profile data is
// PUSH-based and depends on the queue + WS writes, which fail silently in three
// distinct ways:
//
//   1. MOODLE_AUTO_SYNC=false   -> the Mongoose change-capture plugin is never
//      attached (server.js), so editing a student enqueues nothing at all.
//   2. updateUser() only sends email/firstname/lastname — curriculum, grade,
//      package, subjects and dates are never pushed by ANY code path.
//   3. Custom profile fields have no WS wrapper in client.js, so the fields
//      sso.php writes on login are never updated by the backend.
//
// This script queries the LIVE Moodle over the same REST client the backend
// uses, so it reports what Moodle really holds rather than what we assume.
//
// It NEVER writes anything — every Moodle call here is a read.
//
// Usage:
//   node scripts/diagnose-moodle-profile-sync.js                 (config + fields)
//   node scripts/diagnose-moodle-profile-sync.js --name="Williams Mensah"
//   node scripts/diagnose-moodle-profile-sync.js --user=sm_s_abc123
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import MoodleLink from "../models/MoodleLink.js";
import SyncJob from "../models/SyncJob.js";
import { config } from "../services/moodle/config.js";
import { callWs } from "../services/moodle/client.js";

const line = (s = "") => console.log(s);
const head = (s) => line(`\n=== ${s} ===`);
const ok = (s) => line(`  [PASS] ${s}`);
const bad = (s) => line(`  [FAIL] ${s}`);
const warn = (s) => line(`  [WARN] ${s}`);

const arg = (n) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
};
const term = process.argv.slice(2).find((a) => !a.startsWith("--")) || "";

// The custom profile fields the SSO plugin writes on login (sso.php 5c) and that
// README step 3 asks an admin to create by hand.
const EXPECTED_FIELDS = ["curriculum", "grade", "package", "subjects"];


async function reportConfig() {
  head("1. Push configuration (does anything enqueue a sync?)");
  line(`  MOODLE_ENABLED ............. ${config.enabled}`);
  line(`  MOODLE_WS_ENABLED .......... ${config.wsEnabled}`);
  line(`  MOODLE_WS_TOKEN set ....... ${Boolean(config.wsToken)}`);
  line(`  MOODLE_DRY_RUN ............. ${config.dryRun}${config.dryRun ? "   <-- WS writes are SIMULATED" : ""}`);
  line(`  MOODLE_AUTO_SYNC ........... ${process.env.MOODLE_AUTO_SYNC || "(unset)"}`);
  line(`  MOODLE_WORKER_ENABLED ...... ${process.env.MOODLE_WORKER_ENABLED || "(unset)"}`);
  line(`  MOODLE_RECONCILIATION ..... ${process.env.MOODLE_RECONCILIATION_ENABLED || "(unset)"}`);

  if (config.dryRun) bad("MOODLE_DRY_RUN=true -> no WS write ever reaches Moodle.");
  if (String(process.env.MOODLE_AUTO_SYNC || "false") !== "true") {
    bad("MOODLE_AUTO_SYNC is not true -> student edits enqueue NOTHING (this is why nothing syncs).");
  } else ok("MOODLE_AUTO_SYNC=true (edits enqueue a syncProfile job)");
  if (String(process.env.MOODLE_WORKER_ENABLED || "false") !== "true") {
    bad("MOODLE_WORKER_ENABLED is not true -> enqueued jobs are never processed.");
  }
  if (!config.wsEnabled || !config.wsToken) {
    bad("Web Services not usable -> even a processed job cannot write to Moodle.");
  } else ok("WS client can reach a live Moodle");

  head("2. Durable queue (are jobs even being created?)");
  const byStatus = await SyncJob.aggregate([
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const total = byStatus.reduce((a, b) => a + b.n, 0);
  line(`  ${total} job(s) total`);
  byStatus.forEach((b) => line(`    ${b._id}: ${b.n}`));
  const recent = await SyncJob.find({}).sort({ createdAt: -1 }).limit(5).lean();
  if (!recent.length) {
    warn("Queue is EMPTY -> confirm with Admin -> Moodle -> Sync All Students.");
  } else {
    for (const j of recent) {
      line(`    ${new Date(j.createdAt).toISOString()} ${j.type} ${j.status} attempts=${j.attempts ?? 0}`);
      if (j.lastError) line(`        lastError: ${String(j.lastError).slice(0, 200)}`);
    }
  }

  head("3. Live Moodle: do the custom profile fields exist?");
  if (!config.wsEnabled || !config.wsToken || config.dryRun) {
    warn("Cannot query Moodle (WS not live) — skipping field check.");
    return;
  }
  let fields = [];
  try {
    // core_user_get_users_by_field on 'idnumber' proves the token works at all.
    const probe = await callWs("core_webservice_get_site_info");
    ok(`WS handshake OK — Moodle ${probe?.release || probe?.version || "?"}`);
  } catch (e) {
    bad(`WS handshake FAILED: ${e.message}`);
    line("      The token may lack capabilities, or the service user is not permitted.");
    return;
  }
  // Moodle exposes custom fields only through a user record; there is no
  // "list profile fields" WS function, so we read a real SSO user and inspect
  // the keys Moodle returns alongside the core ones.
  const sample = await MoodleLink.findOne({ role: "student", moodleUserId: { $ne: null } }).lean();
  if (!sample) {
    warn("No provisioned Moodle student to inspect — run Sync All Students first.");
    return;
  }
  try {
    const users = await callWs("core_user_get_users_by_field", {
      field: "id", values: [String(sample.moodleUserId)],
    });
    const u = Array.isArray(users) ? users[0] : null;
    if (!u) { warn("Could not read the sample Moodle user."); return; }
    fields = Object.keys(u);
    line(`  Sample user ${sample.moodleUsername} (id ${sample.moodleUserId}) returns ${fields.length} keys`);
    const present = EXPECTED_FIELDS.filter((f) => fields.includes(f));
    const missing = EXPECTED_FIELDS.filter((f) => !fields.includes(f));
    if (present.length) ok(`fields present: ${present.join(", ")}`);
    if (missing.length) {
      bad(`custom profile fields MISSING: ${missing.join(", ")}`);
      line("      Create them in Moodle: Site administration -> Users -> Accounts ->");
      line("      User profile fields. Until then the backend cannot store this data,");
      line("      and any attempt to push it fails with 'Invalid parameter value'.");
    }
  } catch (e) {
    warn(`Could not read user fields: ${e.message}`);
  }
}


function nameTokens(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = parts;
  const last = rest.join(" ");
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = (v) => ({ $regex: `^${esc(v)}`, $options: "i" });
  const or = [{ fullName: rx(parts.join(" ")) }];
  if (last) or.push({ lastname: rx(last), firstname: rx(first) });
  return { $or: or };
}

/** The data Mongo holds that Moodle should be mirroring. */
function expectedFor(doc) {
  return {
    email: doc.email || "",
    name: doc.fullName || doc.name || "",
    curriculum: doc.curriculum || "",
    grade: doc.grade || "",
    package: doc.package || "",
    subjects: Array.isArray(doc.subjectNames) ? doc.subjectNames.join(",") : (doc.subjectNames || ""),
  };
}

async function reportUser({ role, doc }) {
  const name = doc.fullName || doc.name || "(unnamed)";
  head(`${name}  (${role})`);
  const link = await MoodleLink.findOne(
    role === "teacher" ? { teacherRef: doc._id } : { studentRef: doc._id }
  ).lean();

  const want = expectedFor(doc);
  line("  Mongo (source of truth):");
  for (const [k, v] of Object.entries(want)) line(`      ${k.padEnd(11)} = ${v || "(empty)"}`);

  if (!link) {
    bad("no MoodleLink -> never provisioned; the Moodle account has never been created.");
    return;
  }
  if (!link.moodleUserId) {
    bad(`link exists (${link.moodleUsername}) but moodleUserId is null -> account never created in Moodle.`);
    line("      Run Admin -> Moodle -> Sync All Students.");
    return;
  }
  line(`  Moodle: ${link.moodleUsername} (id ${link.moodleUserId}), lastSyncedProfileAt=${link.lastSyncedProfileAt || "never"}`);

  if (!config.wsEnabled || !config.wsToken || config.dryRun) {
    warn("WS not live — cannot read the Moodle side for comparison.");
    return;
  }
  try {
    const users = await callWs("core_user_get_users_by_field", {
      field: "id", values: [String(link.moodleUserId)],
    });
    const u = Array.isArray(users) ? users[0] : null;
    if (!u) { bad("Moodle has no user with that id."); return; }
    line("  Moodle currently holds:");
    const got = {
      email: u.email || "",
      name: `${u.firstname || ""} ${u.lastname || ""}`.trim(),
      curriculum: u.curriculum || "",
      grade: u.grade || "",
      package: u.package || "",
      subjects: u.subjects || "",
    };
    for (const [k, v] of Object.entries(got)) {
      const drift = (v || "") !== (want[k] || "");
      line(`      ${k.padEnd(11)} = ${v || "(empty)"}${drift ? "   <-- DRIFT" : ""}`);
    }
    const drifted = Object.keys(got).filter((k) => (got[k] || "") !== (want[k] || ""));
    if (!drifted.length) ok("Moodle matches Mongo for every checked field.");
    else {
      bad(`${drifted.length} field(s) drifted: ${drifted.join(", ")}`);
      const noField = drifted.filter((f) => f !== "email" && f !== "name" && !u[f]);
      if (noField.length) {
        warn(`${noField.join(", ")} are not returned by Moodle at all -> the custom profile field does not exist.`);
      }
    }
  } catch (e) {
    warn(`Could not read this user from Moodle: ${e.message}`);
  }
}

async function main() {
  await connectDB();
  line("Connected to MongoDB. READ-ONLY — no writes to Mongo or Moodle.");
  await reportConfig();

  if (term || arg("name") || arg("user") || arg("email")) {
    const t = arg("name") || term;
    const q = nameTokens(t);
    const [s, te] = await Promise.all([
      Student.find(q).limit(5).lean(),
      Teacher.find({ $or: q.$or }).limit(5).lean(),
    ]);
    if (!s.length && !te.length) warn(`no principal matches "${t}"`);
    for (const d of s) await reportUser({ role: "student", doc: d });
    for (const d of te) await reportUser({ role: "teacher", doc: d });
  } else {
    head("Pass a name to compare one user, e.g. --name=\"Williams Mensah\"");
  }

  line("\nDone.");
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("\nDiagnostic failed:", err.message);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});


