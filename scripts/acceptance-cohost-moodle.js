// Final acceptance test for the Google Meet co-host + automatic Moodle sync work.
// Run: node scripts/acceptance-cohost-moodle.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const frontend = path.join(root, "..", "studiesmasters-frontend");

let pass = 0;
let fail = 0;
const ok = (label) => { pass++; console.log(`  PASS  ${label}`); };
const no = (label, detail = "") => { fail++; console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`); };
const read = (p) => fs.readFileSync(p, "utf8");
const check = (label, cond) => (cond ? ok(label) : no(label));

console.log("=== ACCEPTANCE: Google Meet co-host + automatic Moodle sync ===\n");

// ---------------------------------------------------------------- backend
console.log("[1] Backend route registration");
const server = read(path.join(root, "server.js"));
check("googleTeacherRoutes mounted", /googleTeacherRoutes/.test(server) && /\/api\/google\/teacher/.test(server));
check("moodleRoutes mounted", /moodleRoutes/.test(server));
check("meetRoutes mounted", /meetRoutes/.test(server));

console.log("\n[2] Teacher model Google fields");
const teacherModel = read(path.join(root, "models", "teacher.js"));
for (const f of ["googleMeetEmail", "googleAccountVerified", "googleVerifiedAt", "googleOAuthState"]) {
  check(`Teacher.${f}`, teacherModel.includes(f));
}

console.log("\n[3] ClassSession co-host tracking");
const cs = read(path.join(root, "models", "ClassSession.js"));
for (const v of ["not_configured", "teacher_verified", "invited", "active", "manual_required"]) {
  check(`coHostStatus value "${v}"`, cs.includes(`"${v}"`));
}
for (const f of ["ownerEmail", "teacherEmail", "meetingLink", "calendarEventId", "conferenceId"]) {
  check(`googleMeet.${f}`, cs.includes(f));
}

console.log("\n[4] Scheduling: Meet link + owner + coHostStatus on create");
const sched = read(path.join(root, "services", "qao", "scheduling.service.js"));
check("sets googleMeet.ownerEmail", sched.includes("ownerEmail: \"virtualclass@studiesmasters.com\""));
check("sets googleMeet.teacherEmail", /teacherEmail:\s*teacherGoogleEmail/.test(sched));
check("sets coHostStatus invited", sched.includes('"invited"'));
check("graceful not_configured fallback", sched.includes('"not_configured"'));
check("automatic Moodle sync after create", /syncClassSession/.test(sched) && /Moodle auto-sync/.test(sched));

console.log("\n[5] Moodle sync carries the Google Meet link");
const syncTimetable = read(path.join(root, "services", "moodle", "syncTimetable.js"));
check("resolveMeetingLink helper", syncTimetable.includes("function resolveMeetingLink"));
check("reads top-level meetingLink", /session\?\.meetingLink/.test(syncTimetable));
check("reads googleMeet.meetingLink", /session\?\.googleMeet\?\.meetingLink/.test(syncTimetable));
check("renders Join Virtual Class link", syncTimetable.includes("Join Virtual Class"));

console.log("\n[6] Teacher join + co-host instructions");
const meetRoutes = read(path.join(root, "routes", "meetRoutes.js"));
check("teacher join endpoint", /teacher\/:sessionId\/join/.test(meetRoutes));
check("returns coHostStatus", meetRoutes.includes("coHostStatus"));
check("returns ownerEmail", meetRoutes.includes("ownerEmail"));

console.log("\n[7] Admin monitoring + audit");
const qao = read(path.join(root, "routes", "qaoRoutes.js"));
check("teacher-google-status dashboard endpoint", qao.includes("/teacher-google-status"));
check("google-account-audit-log endpoint", qao.includes("/google-account-audit-log"));
check("audit model", fs.existsSync(path.join(root, "models", "GoogleAccountAuditLog.js")));
check("attendee service", fs.existsSync(path.join(root, "services", "google", "calendar-attendee.service.js")));
check("teacher oauth service", fs.existsSync(path.join(root, "services", "google", "teacher-oauth.service.js")));

console.log("\n[8] No dummy data left in the backend");
check("legacy dummy seeder deleted", !fs.existsSync(path.join(root, "scripts", "seed-dummy-timetable-notifications.js")));
check("real seeder present", fs.existsSync(path.join(root, "scripts", "seed-real-classes.js")));
check("backfill script present", fs.existsSync(path.join(root, "scripts", "backfill-google-meet.js")));
const realSeeder = read(path.join(root, "scripts", "seed-real-classes.js"));
check("real seeder creates real meetings", realSeeder.includes("createMeeting"));
check("real seeder sets owner email", realSeeder.includes("virtualclass@studiesmasters.com"));
check("no fake dummy meet link", !realSeeder.includes("dummy-test-class"));
const pkg = JSON.parse(read(path.join(root, "package.json")));
check("npm seed:real-classes", Boolean(pkg.scripts["seed:real-classes"]));
check("npm backfill:google-meet", Boolean(pkg.scripts["backfill:google-meet"]));
check("npm inspect:cohost", Boolean(pkg.scripts["inspect:cohost"]));



// --------------------------------------------------------------- frontend
console.log("\n[9] Frontend: no manual Sync buttons, automatic instead");
const teacherDash = read(path.join(frontend, "src", "components", "teacher-dashboard.jsx"));
const studentDash = read(path.join(frontend, "src", "components", "student-dashboard.jsx"));
check("teacher: Sync to Moodle BUTTON removed", !/onClick=\{syncClassesToMoodle\}/.test(teacherDash));
check("teacher: auto sync function present", teacherDash.includes("syncClassesToMoodleAuto"));
check("teacher: auto sync called from fetchTimetable", /syncClassesToMoodleAuto\(\)/.test(teacherDash));
check("teacher: describes automatic Moodle sync", /synced automatically to Moodle/.test(teacherDash));
check("student: Sync to Moodle BUTTON removed", !/onClick=\{syncTimetableToMoodle\}/.test(studentDash));
check("student: auto sync function present", studentDash.includes("syncTimetableToMoodleAuto"));
check("student: auto sync called from refreshTimetable", /syncTimetableToMoodleAuto\(\)/.test(studentDash));
check("student: auto sync called on load", (studentDash.match(/syncTimetableToMoodleAuto\(\)/g) || []).length >= 2);
check("student: DUMMY text removed from UI", !/DUMMY- code/.test(studentDash) && !/Dummy test classes/.test(studentDash));
check("student: mentions Google Meet link", /Google Meet link/.test(studentDash));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail ? 1 : 0;
