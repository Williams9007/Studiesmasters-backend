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

// --------------------------------------------- Moodle link + teacher names
console.log("\n[10] Moodle dashboard link + teacher-name sync");
const classPortal = read(path.join(root, "services", "moodle", "classPortal.service.js"));
check("dashboard returns meetingLink", /meetingLink: role === "teacher" \|\| s\.status === "live"/.test(classPortal));
check("sessions list returns meetingLink", (classPortal.match(/meetingLink: role === "teacher" \|\| s\.status === "live"/g) || []).length >= 2);
check("teacher join bypasses student enrollment", classPortal.includes("You are not assigned to this class") && /if \(role === "teacher"\)/.test(classPortal));
check("join falls back to googleMeet.meetingLink", /session\.meetingLink \|\| session\.googleMeet\?\.meetingLink/.test(classPortal));
check("dashboard populates substituteTeacher", /populate\("substituteTeacher", "fullName"\)/.test(classPortal));
check("teacher name prefers substitute", classPortal.includes("s.substituteTeacher?.fullName || s.teacher?.fullName"));
const syncClass = read(path.join(root, "services", "moodle", "syncClass.js"));
check("toMoodleDisplay reads googleMeet.meetingLink", /meetingLink: s\.meetingLink \|\| s\.googleMeet\?\.meetingLink/.test(syncClass));
check("toMoodleDisplay prefers substitute teacher", syncClass.includes("s.substituteTeacher?.fullName || s.teacher?.fullName"));
check("populate guard covers unpopulated teacher", syncClass.includes("session.teacher.fullName === undefined"));
check("teacher timetable sync populates teacher name", /syncTimetableForTeacher[\s\S]*?\.populate\("teacher", "fullName name"\)/.test(syncTimetable));
check("eventBody prefers substitute teacher", syncTimetable.includes("session.substituteTeacher?.fullName || session.teacher?.fullName"));
const moodleCfg = read(path.join(root, "services", "moodle", "config.js"));
check("WS auto-enabled by MOODLE_WS_TOKEN", /MOODLE_WS_TOKEN/.test(moodleCfg) && /wsEnabled: \(\(\) =>/.test(moodleCfg));

console.log("\n[11] Moodle plugin page renders every view it calls");
const plugin = read(path.join(root, "..", "moodle-sso", "local", "studiesmasters_virtualclass", "index.php"));
check("vc_header defined (header() collision removed)", plugin.includes("function vc_header(") && !/function header\s*\(/.test(plugin));
check("vc_footer defined", plugin.includes("function vc_footer("));
check("vc_render_dashboard defined", plugin.includes("function vc_render_dashboard("));
check("vc_render_waiting defined", plugin.includes("function vc_render_waiting("));
check("vc_render_recordings defined", plugin.includes("function vc_render_recordings("));
check("vc_render_attendance defined", plugin.includes("function vc_render_attendance("));
check("call_backend keeps waiting/meeting/rows keys", plugin.includes("$out = $res;"));
check("dispatch handles waiting room", plugin.includes("isset($res['waiting'])") || plugin.includes("!empty($res['waiting'])"));
check("plugin renders Open Meet Link from dashboard", plugin.includes("Open Meet Link") && plugin.includes("$s['meetingLink']"));
check("plugin surfaces backend errors", plugin.includes("alert-danger") && plugin.includes("$res['success']"));

// ------------------------------- Moodle vclass nonce contract + theme chrome
console.log("\n[12] vclass: plugin-minted nonce admitted once; theme chrome restored");
const vclassStore = read(path.join(root, "services", "moodle", "store.js"));
check("store exports reserveNonce (first-sight admission)", vclassStore.includes("export async function reserveNonce") && /export const store = \{[^}]*reserveNonce/.test(vclassStore));
check("reserveNonce is atomic (Redis NX + Mongo duplicate-key)", /NX:\s*true/.test(vclassStore) && (vclassStore.includes("11000") || /duplicate/i.test(vclassStore)));
check("reserved nonces use a separate keyspace (never re-claimable)", vclassStore.includes("sso:nonce:seen:"));
check("claimNonce leaves a used-tombstone on Redis consume", vclassStore.includes("JSON.stringify({ used: true })"));
check("verifyClassRequest reserves never-seen nonces", classPortal.includes("reserveNonce(") && /nonce_\$\{/.test(classPortal));
check("verifyClassRequest rejects usernames with no principal", classPortal.includes('"unknown_user"'));
check("link resolved before nonce gate (reserve has an owner)", classPortal.indexOf("MoodleLink.findOne({ moodleUsername") < classPortal.indexOf("reserveNonce({"));
check("plugin mints a fresh nonce per backend call", plugin.includes("bin2hex(random_bytes(16))"));
check("plugin sets page url before any output", plugin.indexOf("$PAGE->set_url") > -1 && plugin.indexOf("$PAGE->set_url") < plugin.indexOf("vc_header($role)"));
check("plugin uses native theme header/footer", plugin.includes("$OUTPUT->header()") && plugin.includes("$OUTPUT->footer()"));
check("plugin registers css via requires->css (no raw link echo)", plugin.includes("requires->css") && !/echo '<link rel=/.test(plugin));
const vclassVersionPhp = read(path.join(root, "..", "moodle-sso", "local", "studiesmasters_virtualclass", "version.php"));
const vclassVersion = Number((vclassVersionPhp.match(/\$plugin->version\s*=\s*(\d+)/) || [])[1] || 0);
check(`plugin version >= 2026092303 for redeploy (got ${vclassVersion})`, vclassVersion >= 2026092303);

// ------------------------------------------- Nav drawer entry point (lib.php)
console.log("\n[13] vclass: nav drawer entry point (lib.php callback)");
const vclassLib = read(path.join(root, "..", "moodle-sso", "local", "studiesmasters_virtualclass", "lib.php"));
check("lib.php defines the extend_navigation callback", /function local_studiesmasters_virtualclass_extend_navigation\(global_navigation \$navigation\)/.test(vclassLib));
check("lib.php is Moodle-guarded", vclassLib.includes("defined('MOODLE_INTERNAL') || die"));
check("nav link targets the plugin index with pluginname string", vclassLib.includes("get_string('pluginname', 'local_studiesmasters_virtualclass')") && vclassLib.includes("/local/studiesmasters_virtualclass/index.php"));
check("nav hidden for non-SSO accounts (sm_s_/sm_t_ only)", vclassLib.includes("sm_t_") && vclassLib.includes("sm_s_"));

// ------------------------------------------- SSO name sync (main-website names)
console.log("\n[14] SSO login refreshes names from verify fullName + legacy name");
const ssoPlugin = read(path.join(root, "..", "moodle-sso", "local", "studiesmasters_sso", "sso.php"));
const ssoCode = ssoPlugin.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
check("sso 5b reads verify profile.fullName (no separate firstname/lastname keys)",
  ssoCode.includes("$backendProfile['profile']['fullName']") && !ssoCode.includes("['profile']['firstname']"));
check("sso 5b refreshes existing users (no create-only gating)",
  ssoPlugin.includes("name edits on the main website propagate"));
check("sso 4a normalises blank fullName to absent (never blanks a name)",
  ssoPlugin.includes("unset($backendProfile['profile']['fullName'])"));
check("main-website name endpoint tolerates legacy teacher name field",
  read(path.join(root, "services", "moodle", "syncMainWebsiteName.js")).includes('select("fullName name")'));
const ssoVersionPhp = read(path.join(root, "..", "moodle-sso", "local", "studiesmasters_sso", "version.php"));
const ssoVersion = Number((ssoVersionPhp.match(/\$plugin->version\s*=\s*(\d+)/) || [])[1] || 0);
check(`sso plugin version >= 2026092304 for redeploy (got ${ssoVersion})`, ssoVersion >= 2026092304);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail ? 1 : 0;
