#!/usr/bin/env node
// Read-only Moodle Web Services preflight. It never calls create/update/enrol
// functions and never prints the token, URL credentials, or user records.
import { config } from "../services/moodle/config.js";
import { client, callWs } from "../services/moodle/client.js";

const probes = [
  ["token/user lookup", () => client.getUsersByField("id", ["0"])],
  ["course categories", () => client.getCategories([])],
  ["course listing", () => client.getCourses([])],
  // Functions required by the class-group isolation pipeline
  // (services/moodle/syncClass.js). All READ-ONLY. When these are not enabled
  // for the token's external service, syncClass falls back to its fail-closed
  // "no-group-scope" path and classes are never published to Moodle — so
  // probing them here tells us WHERE the block comes from.
  ["group listing (core_group_get_course_groups)", () => callWs("core_group_get_course_groups", { courseid: 1 })],
  ["group members (core_group_get_group_members)", () => callWs("core_group_get_group_members", { groupids: [1] })],
  ["calendar events (core_calendar_get_calendar_events)", () => callWs("core_calendar_get_calendar_events", { eventids: [] })],
  ["category one (core_course_get_categories)", () => callWs("core_course_get_categories", { options: [] })],
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
  // Moodle rejects calls to functions that exist but are not attached to the
  // token's external service with various wordings; treat them as permissions.
  if (/not allowed|not enabled|permission|requires.*capability|invalid parameter value|web service.*function/i.test(raw)) {
    return "FUNCTION_NOT_ENABLED_FOR_TOKEN";
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

report.ready = !config.dryRun && config.wsEnabled
  && Object.values(report.probes).every((probe) => probe.ok);

// Plain-language verdict so the operator knows the exact next action.
if (!report.ready) {
  const cats = new Set(Object.values(report.probes).filter((p) => !p.ok).map((p) => p.category));
  if (cats.has("INVALID_TOKEN")) {
    report.verdict = "The Moodle WS token is REJECTED (Invalid token). Regenerate it in Moodle → Site administration → Plugins → Web services → Manage tokens, then update MOODLE_WS_TOKEN in .env (and on Render).";
  } else if (cats.has("FUNCTION_NOT_ENABLED_FOR_TOKEN")) {
    report.verdict = "Token is valid but some required functions are NOT attached to its external service. In Moodle → Site administration → Plugins → Web services → External services, add: core_group_get_course_groups, core_group_create_groups, core_group_add_group_members, core_group_update_group_members, core_group_get_group_members (plus core_calendar_* / enrol_manual_* as needed).";
  } else {
    report.verdict = "One or more read probes failed — see probes for the exact errors.";
  }
} else {
  report.verdict = "All read probes passed — token and function permissions are OK.";
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 1;
