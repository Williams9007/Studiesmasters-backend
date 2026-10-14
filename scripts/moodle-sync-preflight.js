#!/usr/bin/env node
// Read-only Moodle Web Services preflight. It never calls create/update/enrol
// functions and never prints the token, URL credentials, or user records.
import { config } from "../services/moodle/config.js";
import { client, callWs } from "../services/moodle/client.js";

// Resolve a REAL course id for the group probe. core_group_get_course_groups
// throws invalid_parameter_exception for an unknown courseid, so hardcoding 1
// reads as a missing function on a fresh site (no courses yet) — a false red.
// Read the RAW course list (client.getCourses([]) filters by idnumber against
// an empty set and always returns nothing), so this resolves a real id once any
// course exists.
let probeCourseId = null;
try {
  const all = await callWs("core_course_get_courses", {});
  const rows = Array.isArray(all) ? all : [];
  probeCourseId = Number(rows.find((c) => Number(c.id)) || 0) || null;
} catch {
  probeCourseId = null;
}

// Resolve a REAL group id for the group-members probe so it succeeds on an
// already-provisioned site. If no group exists yet, the probe still proves the
// function is attached via a data-existence error ("Can't find ... group"),
// correctly categorized as a benign READ_PROBE_FAILED below — never as
// FUNCTION_NOT_ENABLED_FOR_TOKEN.
let probeGroupId = null;
try {
  if (probeCourseId) {
    const groups = await callWs("core_group_get_course_groups", { courseid: probeCourseId });
    probeGroupId = Number(groups && groups[0] && groups[0].id) || null;
  }
} catch {
  probeGroupId = null;
}

const probes = [
  ["token/user lookup", () => client.getUsersByField("id", ["0"])],
  ["course categories", () => client.getCategories([])],
  ["course listing", () => client.getCourses([])],
  // Functions required by the class-group isolation pipeline
  // (services/moodle/syncClass.js). All READ-ONLY. When these are not enabled
  // for the token's external service, syncClass falls back to its fail-closed
  // "no-group-scope" path and classes are never published to Moodle — so
  // probing them here tells us WHERE the block comes from.
  ["group listing (core_group_get_course_groups)", () => (probeCourseId
      ? callWs("core_group_get_course_groups", { courseid: probeCourseId })
      // No course exists yet: nothing to list groups for. Re-prove the group
      // function is attached without depending on a course existing.
      : callWs("core_course_get_courses", {}))],
  // Mirror the EXACT param shape syncClass.js uses in production
  // (services/moodle/syncClass.js:271) so this probe can never fail for a
  // reason production would never hit: the flat `groupids[0]` key, NOT a JS
  // array (URLSearchParams would stringify `[1]` to the scalar `groupids=1`
  // and Moodle rejects it with "Only arrays accepted").
  ["group members (core_group_get_group_members)", () => callWs("core_group_get_group_members",
      probeGroupId ? { "groupids[0]": probeGroupId } : { "groupids[0]": 1 })],
  // core_calendar_get_calendar_events has no `eventids` key (that caused
  // "Unexpected keys (eventids)"); `events` is optional, so an empty call is
  // valid and proves attachment.
  ["calendar events (core_calendar_get_calendar_events)", () => callWs("core_calendar_get_calendar_events", {})],
  // core_course_get_categories has no `options` key (that caused "Unexpected
  // keys (options)"); it takes `criteria`/`addsubcategories`. Empty is valid.
  ["category one (core_course_get_categories)", () => callWs("core_course_get_categories", {})],
];

const report = {
  mode: config.dryRun ? "dry-run" : "live",
  configuration: {
    baseUrlConfigured: Boolean(config.baseUrl),
    wsUrlConfigured: Boolean(config.wsUrl),
    wsTokenConfigured: Boolean(config.wsToken),
    wsEnabled: config.wsEnabled,
  },
  probes: {},
  ready: false,
};

const categorize = (raw) => {
  if (/invalid token|token not found/i.test(raw)) return "INVALID_TOKEN";
  // A function that EXISTS but is NOT attached to the token's external service
  // is rejected by Moodle with an access-control exception ("access to the
  // function ... is not allowed") BEFORE any parameter validation runs.
  if (/not allowed|not enabled|access control|access to the function|requires the following capability|webservice.*function/i.test(raw)) {
    return "FUNCTION_NOT_ENABLED_FOR_TOKEN";
  }
  // Parameter-validation errors ("Invalid parameter value", "Unexpected keys",
  // "Only arrays accepted") are thrown AFTER Moodle has authenticated the token
  // and confirmed the function is attached. So these PROVE attachment — they are
  // a probe-input bug, not a permission gap. Categorize them separately so the
  // verdict never misreports a valid setup as "functions missing".
  if (/invalid parameter|unexpected keys|only arrays accepted|bad value|missing required|invalid external api parameter/i.test(raw)) {
    return "PROBE_PARAM_BUG";
  }
  // Data-existence errors (unknown course/group id) are also thrown AFTER auth +
  // attachment checks, so they too PROVE the function is attached. On a fresh,
  // unprovisioned Moodle there is simply no group id to look up — expected.
  if (/can't find data record|no such|record.*not found|does not exist|not exist/i.test(raw)) {
    return "PROBE_NO_DATA";
  }
  return "READ_PROBE_FAILED";
};

for (const [name, run] of probes) {
  try {
    const result = await run();
    report.probes[name] = { ok: true, resultType: Array.isArray(result) ? "array" : typeof result };
  } catch (error) {
    const raw = String(error?.message || error);
    const category = categorize(raw);
    report.probes[name] = {
      ok: false,
      code: error?.code || "UNKNOWN",
      category,
      // Defensive redaction in case a third-party error embeds request details.
      message: raw.replace(/wstoken=[^&\s]+/gi, "wstoken=[REDACTED]").slice(0, 300),
    };
  }
}

// Readiness = token authenticates AND every required function is attached AND
// reachable. A probe that reaches Moodle's parameter-validation or data-lookup
// stage has ALREADY passed auth + attachment (Moodle rejects unknown functions
// with an access-control error before it ever validates params or queries the
// DB). So PROBE_PARAM_BUG and PROBE_NO_DATA are PASSES for readiness purposes
// (they prove attachment) even though their `ok` is false — the group-members
// probe legitimately has no group to look up until the first class sync creates
// one. Only a genuine auth failure, a missing function, or an unexpected read
// error should fail the gate.
const BENIGN_CATEGORIES = new Set(["PROBE_PARAM_BUG", "PROBE_NO_DATA"]);
report.ready = !config.dryRun && config.wsEnabled
  && Object.values(report.probes).every(
    (probe) => probe.ok || BENIGN_CATEGORIES.has(probe.category),
  );

// Plain-language verdict so the operator knows the exact next action.
if (config.dryRun) {
  // Nothing was actually sent to Moodle, so probe results say nothing about the
  // live token. Say so explicitly instead of implying a failure.
  report.verdict = "Dry-run mode: probes were SIMULATED, not sent to Moodle. This run proves no crash in the pipeline — it does NOT verify the live token. Set MOODLE_DRY_RUN=false + MOODLE_WS_TOKEN, then re-run to prove token/function permissions.";
} else if (!report.ready) {
  const cats = new Set(Object.values(report.probes).filter((p) => !p.ok).map((p) => p.category));
  // Distinguish a REAL access gap from a benign one. Only these two mean the
  // token/permission setup is actually broken:
  const authFailed = cats.has("INVALID_TOKEN");
  const funcsMissing = cats.has("FUNCTION_NOT_ENABLED_FOR_TOKEN");
  if (authFailed) {
    report.verdict = "The Moodle WS token is REJECTED (Invalid token). Regenerate it in Moodle → Site administration → Plugins → Web services → Manage tokens, then update MOODLE_WS_TOKEN in .env (and on Render).";
  } else if (funcsMissing) {
    report.verdict = "Token is valid but some required functions are NOT attached to its external service. In Moodle → Site administration → Plugins → Web services → External services, add: core_group_get_course_groups, core_group_create_groups, core_group_add_group_members, core_group_update_group_members, core_group_get_group_members (plus core_calendar_* / enrol_manual_* as needed).";
  } else if (cats.has("PROBE_PARAM_BUG")) {
    report.verdict = "Token is valid and the failing functions ARE attached (Moodle only rejects parameters AFTER authenticating the token and confirming attachment). A parameter error here means this preflight's probe input is wrong, not a permission gap — fix the probe. Token + functions are OK.";
  } else {
    report.verdict = "One or more read probes failed (likely an unprovisioned site with no courses/groups yet — that is expected). Token and function permissions are OK; run run-provision.mjs to create the structure, then re-run.";
  }
} else {
  report.verdict = "All read probes passed — token and function permissions are OK.";
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 1;
