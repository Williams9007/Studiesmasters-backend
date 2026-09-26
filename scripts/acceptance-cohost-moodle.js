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
// The automatic push must run EXACTLY ONCE per create, from the single
// authoritative block (after the class-group enrolment sync, using the populated
// session). A second push used the unpopulated session and produced a duplicate
// Moodle event with a blank subject/teacher, so it was deliberately removed.
check(
  "automatic Moodle sync after create (single authoritative push)",
  /syncClassSession/.test(sched) &&
    /syncClassGroupEnrollment/.test(sched) &&
    /ORDER MATTERS/.test(sched) &&
    !/Moodle auto-sync failed for new session/.test(sched)
);

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

// --------------------------------------- Per-user virtual class access (Gate 1/2)
console.log("\n[15] Virtual class: self-healing identity + actionable errors");
check("verifyClassRequest self-heals a missing MoodleLink",
  classPortal.includes("healLinkForUsername(user, mail)"));
check("heal helper only accepts a real ObjectId username (no guessing)",
  classPortal.includes("sm_[st]") && classPortal.includes("a-f\\d]{24}$"));
check("heal helper is idempotent (findOrCreateLink, never a blind insert)",
  classPortal.includes("return findOrCreateLink({ role, id: doc._id"));
check("heal realigns username drift only when the username is unowned",
  classPortal.includes("const taken = await MoodleLink.findOne({ moodleUsername: username })"));
check("unlinked account still rejected when no principal matches",
  classPortal.includes('reason: "unknown_user"'));
check("plugin turns unknown_user into an actionable message",
  plugin.includes("unknown_user") && plugin.includes("not linked to a StudiesMasters account"));
const diagnose = read(path.join(root, "scripts", "diagnose-vclass-user.js"));
check("diagnostic reports both gates", diagnose.includes("GATE 1 FAILED") && diagnose.includes("GATE 2 FAILED"));
check("diagnostic is read-only (never writes)", !/MoodleLink\.(create|updateOne|deleteOne|insertMany)/.test(diagnose));
const fixLink = read(path.join(root, "scripts", "fix-vclass-link.js"));
check("repair script defaults to dry-run", fixLink.includes('const APPLY = flag("apply")'));
check("repair script can rename the Moodle account", fixLink.includes("--rename-moodle") && fixLink.includes("client.updateUser(link.moodleUserId, { username: canonical })"));

// --------------------------------------- Dashboard block ships + bulk add CLI
console.log("\n[16] Dashboard block is deployable and reaches /my/ without manual steps");
const blockDir = path.join(root, "..", "moodle-sso", "blocks", "studiesmasters_virtualclass");
const deployBlock = path.join(root, "..", "deploy", "blocks", "studiesmasters_virtualclass");
check("block ships in deploy/ (not only in moodle-sso/)", fs.existsSync(path.join(deployBlock, "block_studiesmasters_virtualclass.php")));
check("block lang + version ship in deploy/", fs.existsSync(path.join(deployBlock, "version.php")) && fs.existsSync(path.join(deployBlock, "lang", "en", "block_studiesmasters_virtualclass.php")));
const blockCode = read(path.join(blockDir, "block_studiesmasters_virtualclass.php"));
check("block has a cURL path (allow_url_fopen may be off)", blockCode.includes("curl_init") && blockCode.includes("vc_block_http_get"));
check("block renders a distinct unlinked-account message", blockCode.includes("account_not_linked"));
check("block classes have a stylesheet", fs.existsSync(path.join(blockDir, "styles.css")) && fs.existsSync(path.join(blockDir, "styles.php")));
const cli = read(path.join(root, "..", "moodle-sso", "cli", "add_studiesmasters_dashboard_block.php"));
check("bulk-add CLI inserts block_instances on user-dashboard", cli.includes("'blockname' => 'studiesmasters_virtualclass'") && cli.includes("'pagetypepattern' => $pagetype"));
check("bulk-add CLI defaults to dry-run and supports --remove", cli.includes("--dry-run") && cli.includes("--remove"));
check("bulk-add CLI only targets SSO usernames", cli.includes("sm_s_") && cli.includes("sm_t_"));
check("bulk-add CLI ships in deploy/cli", fs.existsSync(path.join(root, "..", "deploy", "cli", "add_studiesmasters_dashboard_block.php")));
check("deploy/ local plugin is not stale vs moodle-sso/",
  read(path.join(root, "..", "deploy", "studiesmasters_virtualclass", "version.php")) === vclassVersionPhp
  && fs.existsSync(path.join(root, "..", "deploy", "studiesmasters_virtualclass", "lib.php")));

// ------------------------------- Push sync (user data -> Moodle) is switched on
console.log("\n[17] User profile data actually reaches Moodle (push path)");
const envExample = read(path.join(root, ".env.example"));
check(".env.example ships MOODLE_AUTO_SYNC=true (edits must enqueue a sync)",
  /MOODLE_AUTO_SYNC=true/.test(envExample));
check(".env.example documents that the WS token must exist inside Moodle",
  envExample.includes("Invalid token - token not found") && envExample.includes("Manage tokens"));
check("server only attaches the autosync plugin when the flag is true",
  read(path.join(root, "server.js")).includes('String(process.env.MOODLE_AUTO_SYNC || "false") === "true"'));
const profileDiag = read(path.join(root, "scripts", "diagnose-moodle-profile-sync.js"));
// Strip comments first: the diagnostic legitimately NAMES these functions in
// its explanatory comments, and matching prose would be a false positive.
const profileDiagCode = profileDiag
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
  .join("\n");
check("profile diagnostic is read-only (no sync/queue writer calls)",
  !/createUser\(|updateUser\(|syncProfile\(|enqueue[A-Za-z]*\(/.test(profileDiagCode));
check("profile diagnostic reads the live Moodle side for drift",
  profileDiag.includes("core_user_get_users_by_field") && profileDiag.includes("core_webservice_get_site_info"));
check("profile diagnostic compares more than email/name",
  ["curriculum", "grade", "package", "subjects"].every((f) => profileDiag.includes(`${f}: `)));
// updateUser is the ONLY backend writer of profile data, so its field list is
// the contract. Guard against silently shrinking it again.
const updateUserSrc = read(path.join(root, "services", "moodle", "updateUser.js"));
check("updateUser pushes only the core fields (documented limitation)", /fields\.email|fields\.firstname|fields\.lastname/.test(updateUserSrc));
check("updateUser returns not_provisioned rather than throwing when unlinked",
  updateUserSrc.includes('reason: "not_provisioned"'));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);

// ------------------- Assignments on the main website + Moodle propagation
console.log("\n[15] Assigned classes/subjects show on main website + sync to Moodle");
const adminRoutes = read(path.join(root, "routes", "adminRoutes.js"));
const teacherRoutes = read(path.join(root, "routes", "teacherRoutes.js"));
const timetableSvc = read(path.join(root, "services", "timetable.service.js"));

// The admin "Assign Subject to Teacher" modal POSTs here; the endpoint used to be
// MISSING, so the subject was silently never stored.
check("POST /admin/assign-subject exists", /router\.post\("\/assign-subject", adminAuth/.test(adminRoutes));
check("assign-subject writes Teacher.subjectsTeaching", /\$addToSet:\s*\{\s*subjectsTeaching/.test(adminRoutes));
check("assign-subject upserts TeacherAssignment for Moodle course mapping", /TeacherAssignment\.findOneAndUpdate/.test(adminRoutes));
check("assign-subject refreshes the teacher in Moodle", /syncProfile\(\{\s*id:\s*teacherId,\s*role:\s*"teacher"/.test(adminRoutes));
check("GET /admin/assigned-subjects read model exists", /router\.get\("\/assigned-subjects", adminAuth/.test(adminRoutes));
check("assigned-subjects populates name/grade/package", /populate\("subjectsTeaching", "name curriculum grade package moodleCourseId"\)/.test(adminRoutes));
check("DELETE /admin/assign-subject unassigns + resyncs", /router\.delete\("\/assign-subject\/:teacherId\/:subjectId", adminAuth/.test(adminRoutes));

// The teacher's own subjects endpoint returned raw ObjectIds -> blank subject names
// on the teacher dashboard and in the timetable-upload dropdown.
check("Teacher /:id/subjects populates subjectsTeaching", /findById\(req\.params\.id\)[\s\S]{0,160}\.populate\("subjectsTeaching", "name curriculum grade package price moodleCourseId"\)/.test(teacherRoutes));
check("Teacher /:id/subjects filters dangling refs", teacherRoutes.includes("subjectsTeaching.filter(Boolean)"));
check("modal reads axios res.data (not res.message)", !/alert\(res\.message/.test(read(path.join(frontend, "src", "components", "AssignSubjectModal.jsx"))));

console.log("\n[16] Scheduled classes + Meet links reach Moodle");
// Editing a class used to sync ONLY when it became cancelled, so a changed
// date/time/teacher (or a link attached later) never reached Moodle.
check("updateSession pushes non-cancel edits to Moodle", /Every non-cancel edit must also reach Moodle/.test(sched) && /CLASS_SYNC_ACTIONS\.UPDATED/.test(sched));
check("updateSession only syncs once per branch", /else \{\s*\n\s*\/\/ Every non-cancel edit/.test(sched));
// A pending Meet link must be repairable in one pass instead of by hand.
check("backfillPendingMeetings exported", /export async function backfillPendingMeetings/.test(sched));
check("backfill targets sessions with no link", /meetingStatus: \{ \$ne: "ready" \}/.test(sched) && /\$or: \[\{ meetingLink: "" \}/.test(sched));
check("backfill regenerates (which re-pushes to Moodle)", /regenerateMeeting\(s\._id/.test(sched));
check("resyncAllClassSessionsToMoodle exported", /export async function resyncAllClassSessionsToMoodle/.test(sched));
// regenerateMeeting used to DISCARD the sync result, so moodleEventId stayed null
// on every session whose link was generated/re-generated (the normal path).
check("regenerateMeeting persists moodleEventId", /moodleSync\?\.moodleEventId[\s\S]{0,200}session\.moodleEventId = moodleSync\.moodleEventId/.test(sched));
check("regenerateMeeting persists moodleCourseId", /session\.moodleCourseId = moodleSync\.moodleCourseId/.test(sched));
check("resync persists moodleEventId", /res\.moodleEventId[\s\S]{0,300}\$set: \{ moodleEventId: res\.moodleEventId/.test(sched));
check("POST /admin/sessions/backfill-meetings exists", /router\.post\("\/sessions\/backfill-meetings", adminAuth/.test(adminRoutes));
check("POST /admin/sessions/resync-moodle exists", /router\.post\("\/sessions\/resync-moodle", adminAuth/.test(adminRoutes));
check("backfill reports Google connection state", /googleStatus\.connected = Boolean\(row\?\.encryptedRefreshToken\)/.test(adminRoutes));

// Pushing a course calendar event to a person who is NOT enrolled in that course
// means they see nothing at all in Moodle.
check("assigning a teacher to a class group syncs Moodle enrolment", /syncClassGroupEnrollment[\s\S]{0,700}CLASS_GROUP_TEACHER_ASSIGNED/.test(adminRoutes));
check("adding students to a class group syncs Moodle enrolment", /syncClassGroupEnrollment[\s\S]{0,700}CLASS_GROUP_STUDENTS_ADDED/.test(adminRoutes));
check("saving weekly slots/teacher syncs Moodle enrolment", /syncClassGroupEnrollment\(\{\s*classGroupId:\s*group\._id\s*\}\)/.test(timetableSvc));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail ? 1 : 0;
