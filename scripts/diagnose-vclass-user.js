// scripts/diagnose-vclass-user.js
//
// READ-ONLY live diagnostic: explains why ONE user sees classes in the Moodle
// Virtual Classroom and another sees an empty page.
//
// The Moodle plugin does NOT look users up by name. It signs the Moodle
// username and the backend resolves it in two gates:
//
//   Gate 1 (identity)    classPortal.service.js verifyClassRequest()
//     MoodleLink.findOne({ moodleUsername: user }) -> studentRef/teacherRef
//     No link -> HTTP 401 "unknown_user" -> empty page, no classes at all.
//   Gate 2 (entitlement) classPortal.service.js dashboardForUser()
//     ClassGroup.find({ students: principalId })
//     (teachers: teacher / substituteTeacher)
//     Not in a group -> resolves fine but courses/liveNow/upcoming are all [].
//
// Both failures look IDENTICAL from the browser ("no classes"), so this script
// names the failing gate. It also reports username drift, the subtlest cause:
// moodleUsernameFor() derives sm_s_/sm_t_ from the immutable Mongo _id, but
// store.js findOrCreateLink() silently REWRITES moodleUsername when a link was
// first created from a different id source. The Moodle account keeps logging in
// under the OLD username, so the canonical lookup misses -> unknown_user.
//
// It NEVER writes anything — safe to run against production.
//
// Usage:
//   node scripts/diagnose-vclass-user.js                     (audit everyone)
//   node scripts/diagnose-vclass-user.js "Williams Mensah"   (by name, fuzzy)
//   node scripts/diagnose-vclass-user.js --user=sm_s_abc123  (by Moodle username)
//   node scripts/diagnose-vclass-user.js --email=a@b.com     (by email)
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import MoodleLink from "../models/MoodleLink.js";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";
import { moodleUsernameFor } from "../services/moodle/store.js";

const line = (s = "") => console.log(s);
const head = (s) => line(`\n=== ${s} ===`);
const ok = (s) => line(`  [PASS] ${s}`);
const bad = (s) => line(`  [FAIL] ${s}`);
const warn = (s) => line(`  [WARN] ${s}`);

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : "";
};
const term = process.argv.slice(2).find((a) => !a.startsWith("--")) || "";

/** Split a full name into first/last tokens for a case-insensitive $or match. */
function nameTokens(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = parts;
  const last = rest.join(" ");
  const rx = (v) => ({ $regex: `^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" });
  const or = [{ fullName: rx(parts.join(" ")) }];
  if (last) or.push({ lastname: rx(last), firstname: rx(first) });
  return { $or: or };
}

async function findPrincipals() {
  if (arg("email")) {
    const mail = arg("email").trim().toLowerCase();
    const [s, t] = await Promise.all([
      Student.findOne({ email: mail }).lean(),
      Teacher.findOne({ email: mail }).lean(),
    ]);
    const out = [];
    if (s) out.push({ role: "student", doc: s });
    if (t) out.push({ role: "teacher", doc: t });
    if (!out.length) warn(`no Student/Teacher with email ${mail}`);
    return out;
  }
  if (arg("user")) {
    const username = arg("user").trim().toLowerCase();
    const link = await MoodleLink.findOne({ moodleUsername: username }).lean();
    if (!link) {
      bad(`no MoodleLink with moodleUsername "${username}" -> Gate 1 (unknown_user).`);
      const kind = username.startsWith("sm_t") ? "teacher" : "student";
      const Model = kind === "teacher" ? Teacher : Student;
      const hex = username.replace(/^sm_[st]_/, "");
      const doc = /^[a-f\d]{24}$/i.test(hex) ? await Model.findById(hex).lean().catch(() => null) : null;
      if (doc) line(`  recovered principal by id: ${doc.fullName || doc.name || doc._id}`);
      return [];
    }
    if (link.studentRef) return [{ role: "student", doc: await Student.findById(link.studentRef).lean() }];
    if (link.teacherRef) return [{ role: "teacher", doc: await Teacher.findById(link.teacherRef).lean() }];
    return [];
  }
  if (term) {
    const q = nameTokens(term);
    const [students, teachers] = await Promise.all([
      Student.find(q).limit(10).lean(),
      Teacher.find({ $or: q.$or }).limit(10).lean(),
    ]);
    const out = [];
    for (const doc of students) out.push({ role: "student", doc });
    for (const doc of teachers) out.push({ role: "teacher", doc });
    if (!out.length) warn(`no principal matches "${term}"`);
    return out;
  }
  return null; // means "everyone"
}

const todayStr = () => new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000)
  .toISOString().slice(0, 10);


async function report({ role, doc }) {
  const name = doc.fullName || doc.name || "(unnamed)";
  const expected = moodleUsernameFor({ role, id: doc._id, userId: doc.userId });

  head(`${name}  (${role})`);
  line(`  _id .............. ${doc._id}`);
  line(`  userId ........... ${doc.userId || "(none)"}`);
  line(`  email ............ ${doc.email || "(none)"}`);
  line(`  curriculum/grade . ${doc.curriculum || "-"} / ${doc.grade || "-"}`);
  line(`  expected username  ${expected}`);

  // ---- Gate 1: identity -----------------------------------------------------
  const link = await MoodleLink.findOne(
    role === "teacher" ? { teacherRef: doc._id } : { studentRef: doc._id }
  ).lean();

  if (!link) {
    bad("GATE 1 FAILED: no MoodleLink -> backend returns unknown_user, page is empty.");
    line(`          Fix: node scripts/fix-vclass-link.js --name="${name}"`);
  } else {
    ok(`MoodleLink: moodleUserId=${link.moodleUserId ?? "?"} role=${link.role} username=${link.moodleUsername}`);
    line(`          enrolledCourseIds=[${(link.enrolledCourseIds || []).join(",") || "-"}]  suspended=${link.suspended}  active=${link.active}`);

    if (link.moodleUsername !== expected) {
      bad(`USERNAME DRIFT: link is "${link.moodleUsername}" but canonical is "${expected}".`);
      line("          Moodle logs in with the old name; the backend looks up the canonical one -> unknown_user.");
      line(`          Fix: node scripts/fix-vclass-link.js --name="${name}" --rename-moodle`);
    } else {
      ok("username matches the canonical derived value");
    }
    if (link.role && link.role !== role) {
      warn(`link.role="${link.role}" but this principal is a ${role}; runtime role comes from link.role.`);
    }
    if (link.suspended) warn("link.suspended = true");
  }

  // ---- Gate 2: entitlement --------------------------------------------------
  const groups = role === "teacher"
    ? await ClassGroup.find({ $or: [{ teacher: doc._id }, { substituteTeacher: doc._id }] })
        .select("code subject grade curriculum students capacity status").lean()
    : await ClassGroup.find({ students: doc._id })
        .select("code subject grade curriculum students capacity status").lean();

  if (!groups.length) {
    bad("GATE 2 FAILED: in no ClassGroup -> courses/liveNow/upcoming are all empty.");
    line("          Payment/subscription is NOT a class seat; group membership grants classes.");
  } else {
    ok(`${groups.length} class group(s):`);
    for (const g of groups) {
      line(`          ${g.code} · ${g.subject} · ${g.grade} · ${g.curriculum} · ${g.status} · seats ${(g.students || []).length}/${g.capacity}`);
    }
  }

  // ---- Session visibility (what the dashboard would actually show) ----------
  const today = todayStr();
  const sessions = role === "teacher"
    ? await ClassSession.find({ $or: [{ teacher: doc._id }, { substituteTeacher: doc._id }] })
        .populate("classGroup", "code").sort({ date: 1, startTime: 1 }).lean()
    : await ClassSession.find({ classGroup: { $in: groups.map((g) => g._id) } })
        .populate("classGroup", "code").sort({ date: 1, startTime: 1 }).lean();

  const live = sessions.filter((s) => s.status === "live");
  const upcoming = sessions.filter(
    (s) => s.status === "scheduled" && new Date(s.date).toISOString().slice(0, 10) >= today
  );
  const history = sessions.filter((s) => !live.includes(s) && !upcoming.includes(s));

  line(`\n  sessions: liveNow=${live.length} upcoming=${upcoming.length} history=${history.length} (today=${today})`);
  for (const s of live) {
    line(`    LIVE     ${s.classGroup?.code} ${new Date(s.date).toISOString().slice(0, 10)} ${s.startTime} meet=${Boolean(s.meetingLink || s.googleMeet?.meetingLink)}`);
  }
  for (const s of upcoming.slice(0, 5)) {
    line(`    UPCOMING ${s.classGroup?.code} ${new Date(s.date).toISOString().slice(0, 10)} ${s.startTime} status=${s.status}`);
  }
  if (!live.length && !upcoming.length) {
    warn("No live/upcoming sessions -> even a perfect Gate 1 + Gate 2 renders an empty dashboard.");
  }
  line();
}

async function main() {
  await connectDB();
  line("Connected to MongoDB. READ-ONLY diagnostic.\n");

  const targets = await findPrincipals();

  if (targets === null) {
    head("No search term given — auditing every principal");
    const [students, teachers] = await Promise.all([Student.find({}).lean(), Teacher.find({}).lean()]);
    line(`  ${students.length} student(s), ${teachers.length} teacher(s)\n`);

    const links = await MoodleLink.find({}).select("studentRef teacherRef moodleUsername").lean();
    const byStudent = new Set(links.filter((l) => l.studentRef).map((l) => String(l.studentRef)));
    const byTeacher = new Set(links.filter((l) => l.teacherRef).map((l) => String(l.teacherRef)));

    head("Principals WITHOUT a MoodleLink (Gate 1 broken — these see nothing)");
    let n = 0;
    for (const s of students) {
      if (!byStudent.has(String(s._id))) { bad(`${s.fullName} · ${s.email} · expected ${moodleUsernameFor({ role: "student", id: s._id })}`); n++; }
    }
    for (const t of teachers) {
      if (!byTeacher.has(String(t._id))) { bad(`${t.fullName || t.name} · ${t.email} · expected ${moodleUsernameFor({ role: "teacher", id: t._id })}`); n++; }
    }
    if (!n) ok("every principal has a MoodleLink");

    head("Username drift (Gate 1 broken in a subtler way)");
    let d = 0;
    for (const l of links) {
      const ref = l.studentRef || l.teacherRef;
      if (!ref) continue;
      const role = l.studentRef ? "student" : "teacher";
      const want = moodleUsernameFor({ role, id: ref });
      if (l.moodleUsername !== want) { bad(`link says "${l.moodleUsername}", canonical is "${want}" (ref ${ref})`); d++; }
    }
    if (!d) ok("no username drift");
    line();
  } else {
    for (const t of targets) await report(t);
  }

  line("Done.");
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("\nDiagnostic failed:", err.message);
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  process.exit(1);
});

