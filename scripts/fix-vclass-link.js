// scripts/fix-vclass-link.js
//
// REPAIR script for the "one user sees classes, another sees nothing" bug.
//
// Use scripts/diagnose-vclass-user.js first — it tells you which gate failed.
// This script fixes GATE 1 (identity) only, because that is the gate that
// hard-fails (HTTP 401 unknown_user). Gate 2 (class-group membership) is a
// deliberate business decision (who is in which classroom) and is NOT
// automated here, by design.
//
//   Fixes applied, each idempotent:
//     1. missing MoodleLink      -> created via findOrCreateLink()
//     2. username drift         -> moodleUsername reset to the canonical
//                                  sm_s_/sm_t_ value derived from the _id
//     3. Moodle rename (opt-in) -> the Moodle account is renamed to match,
//                                  so the user keeps logging in under the
//                                  canonical name (needs MOODLE_WS_ENABLED)
//     4. stale role/suspended   -> role corrected, suspended cleared
//
// Usage (dry-run is the default — nothing is written unless --apply):
//   node scripts/fix-vclass-link.js --name="Williams Mensah"            (report)
//   node scripts/fix-vclass-link.js --name="Williams Mensah" --apply    (write)
//   node scripts/fix-vclass-link.js --name="Williams Mensah" --apply --rename-moodle
//   node scripts/fix-vclass-link.js --all                              (every user)
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import MoodleLink from "../models/MoodleLink.js";
import { moodleUsernameFor, findOrCreateLink } from "../services/moodle/store.js";
import { config } from "../services/moodle/config.js";

const line = (s = "") => console.log(s);
const head = (s) => line(`\n=== ${s} ===`);

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
};
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const APPLY = flag("apply");
const ALL = flag("all");
const RENAME = flag("rename-moodle");


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

async function resolveTargets() {
  if (arg("email")) {
    const mail = arg("email").trim().toLowerCase();
    const [s, t] = await Promise.all([
      Student.findOne({ email: mail }).lean(),
      Teacher.findOne({ email: mail }).lean(),
    ]);
    const out = [];
    if (s) out.push({ role: "student", doc: s });
    if (t) out.push({ role: "teacher", doc: t });
    return out;
  }
  const term = process.argv.slice(2).find((a) => !a.startsWith("--")) || "";
  if (ALL) {
    const [students, teachers] = await Promise.all([Student.find({}).lean(), Teacher.find({}).lean()]);
    return [
      ...students.map((doc) => ({ role: "student", doc })),
      ...teachers.map((doc) => ({ role: "teacher", doc })),
    ];
  }
  if (!term) return [];
  const q = nameTokens(term);
  const [students, teachers] = await Promise.all([
    Student.find(q).limit(10).lean(),
    Teacher.find({ $or: q.$or }).limit(10).lean(),
  ]);
  return [
    ...students.map((doc) => ({ role: "student", doc })),
    ...teachers.map((doc) => ({ role: "teacher", doc })),
  ];
}


/**
 * Repair one principal's MoodleLink. Idempotent: safe to re-run.
 * Returns a list of human-readable actions taken (empty when nothing was wrong).
 */
async function repair({ role, doc }) {
  const name = doc.fullName || doc.name || "(unnamed)";
  const canonical = moodleUsernameFor({ role, id: doc._id, userId: doc.userId });
  const actions = [];

  head(`${name}  (${role})`);
  line(`  _id ${doc._id}`);
  line(`  canonical username: ${canonical}`);

  const refKey = role === "teacher" ? { teacherRef: doc._id } : { studentRef: doc._id };
  let link = await MoodleLink.findOne(refKey);

  // ---- 1. missing link ------------------------------------------------------
  if (!link) {
    line("  [FIX] MoodleLink is MISSING -> creating it");
    actions.push("created MoodleLink");
    if (!APPLY) {
      line("        (dry-run: re-run with --apply to write)");
    } else {
      link = await findOrCreateLink({ role, id: doc._id, userId: doc.userId, email: doc.email });
      line(`        created: ${link.moodleUsername}`);
    }
  } else {
    line(`  existing link: ${link.moodleUsername} (moodleUserId=${link.moodleUserId ?? "?"}, role=${link.role})`);

    // ---- 2. username drift -------------------------------------------------
    if (link.moodleUsername !== canonical) {
      line(`  [FIX] username drift: "${link.moodleUsername}" -> "${canonical}"`);
      actions.push(`renamed link ${link.moodleUsername} -> ${canonical}`);
      if (APPLY) {
        link.moodleUsername = canonical;
        link.markModified("moodleUsername");
      } else {
        line("        (dry-run: re-run with --apply to write)");
      }

      // ---- 3. rename the Moodle account itself ------------------------------
      // The user logs in with the Moodle username, so the backend link AND the
      // Moodle account must agree. Without this the user still logs in under the
      // old name and the canonical lookup keeps missing.
      if (RENAME) {
        if (!config.wsEnabled) {
          line("  [SKIP] --rename-moodle needs MOODLE_WS_ENABLED=true (WS calls are off)");
        } else if (link.moodleUserId) {
          line(`  [FIX] renaming Moodle user ${link.moodleUserId} to "${canonical}"`);
          actions.push(`renamed Moodle user ${link.moodleUserId}`);
          if (APPLY) {
            const { client } = await import("../services/moodle/client.js");
            await client.updateUser(link.moodleUserId, { username: canonical });
            line("        Moodle account renamed");
          } else {
            line("        (dry-run: re-run with --apply to write)");
          }
        } else {
          line("  [SKIP] link has no moodleUserId yet; run a sync first, then re-run");
        }
      }
    }

    // ---- 4. role / suspended drift -----------------------------------------
    if (link.role !== role) {
      line(`  [FIX] role drift: "${link.role}" -> "${role}"`);
      actions.push(`role ${link.role} -> ${role}`);
      if (APPLY) { link.role = role; } else { line("        (dry-run)"); }
    }
    if (link.suspended) {
      line("  [FIX] link.suspended = true -> false");
      actions.push("cleared suspended");
      if (APPLY) { link.suspended = false; } else { line("        (dry-run)"); }
    }
  }

  if (!actions.length) line("  [OK] nothing to fix — this user's link is healthy");
  else if (!APPLY) line("  dry-run only. Re-run with --apply to persist.");
  line();
  return actions;
}


async function main() {
  await connectDB();
  head("Mode");
  line(`  apply ...... ${APPLY}${APPLY ? "" : "  (DRY RUN — nothing is written)"}`);
  line(`  all ........ ${ALL}`);
  line(`  rename ..... ${RENAME}`);
  line(`  wsEnabled .. ${config.wsEnabled}`);
  line(`  dryRun ..... ${config.dryRun}`);

  const targets = await resolveTargets();
  if (!targets.length) {
    line("\nNo principal matched. Pass --name=\"...\", --email=..., or --all.");
    await mongoose.connection.close();
    return;
  }

  head(`Repairing ${targets.length} principal(s)`);
  let changed = 0;
  const touched = [];
  for (const t of targets) {
    const actions = await repair(t);
    if (actions.length) { changed++; touched.push(`${t.doc.fullName || t.doc.name}: ${actions.join("; ")}`); }
  }

  // Persist mutations made to EXISTING links (a link created by
  // findOrCreateLink is already saved by that call).
  if (APPLY) {
    for (const t of targets) {
      const role = t.role;
      const refKey = role === "teacher" ? { teacherRef: t.doc._id } : { studentRef: t.doc._id };
      const link = await MoodleLink.findOne(refKey);
      if (link?.isModified()) await link.save();
    }
  }

  head("Summary");
  if (!changed) {
    line("  nothing needed fixing.");
  } else {
    line(`  ${changed} principal(s) ${APPLY ? "repaired" : "need repair"}:`);
    touched.forEach((t) => line(`    - ${t}`));
  }
  if (!APPLY && changed) {
    line("\n  Re-run with --apply to persist the changes above.");
  }
  line("\nNOTE: this fixes identity (Gate 1) only. If the user is still empty,");
  line("      re-run scripts/diagnose-vclass-user.js — a GATE 2 failure means");
  line("      they are not a member of any ClassGroup, which is a staffing");
  line("      decision, not a bug.");
  line();

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("\nRepair failed:", err.message);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});
