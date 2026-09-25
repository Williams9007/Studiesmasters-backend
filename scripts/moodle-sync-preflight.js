#!/usr/bin/env node
// Read-only Moodle Web Services preflight. It never calls create/update/enrol
// functions and never prints the token, URL credentials, or user records.
import { config } from "../services/moodle/config.js";
import { client } from "../services/moodle/client.js";

const probes = [
  ["token/user lookup", () => client.getUsersByField("id", ["0"])],
  ["course categories", () => client.getCategories([])],
  ["course listing", () => client.getCourses([])],
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

for (const [name, run] of probes) {
  try {
    const result = await run();
    report.probes[name] = { ok: true, resultType: Array.isArray(result) ? "array" : typeof result };
  } catch (error) {
    const raw = String(error?.message || error);
    const invalidToken = /invalid token|token not found/i.test(raw);
    report.probes[name] = {
      ok: false,
      code: error?.code || "UNKNOWN",
      category: invalidToken ? "INVALID_TOKEN" : "READ_PROBE_FAILED",
      // Defensive redaction in case a third-party error embeds request details.
      message: raw.replace(/wstoken=[^&\s]+/gi, "wstoken=[REDACTED]").slice(0, 300),
    };
  }
}

report.ready = !config.dryRun && config.wsEnabled
  && Object.values(report.probes).every((probe) => probe.ok);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 1;
