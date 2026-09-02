// services/moodle/metrics.js
//
// Lightweight health + monitoring façade. Exposes counters and a health
// payload suitable for dashboards / alerting. The health/probe endpoint also
// surfaces Moodle availability (by attempting a cheap status call when WS is on).

import { config, secrets } from "./config.js";
import SyncJob from "../../models/SyncJob.js";
import { client } from "./client.js";
import logger from "../../utils/logger.js";

const counters = {
  ssoIssued: 0,
  ssoOk: 0,
  loginFailures: 0,
  wsErrors: 0,
  enrollFailures: 0,
  lastSsoAtMilli: null,
};

export function bump(metric, amount = 1) {
  if (!(metric in counters)) counters[metric] = 0;
  counters[metric] += amount;
  if (metric === "ssoIssued") counters.lastSsoAt = Date.now();
  if (metric === "loginFailures") counters.lastFailureAt = Date.now();
}

export function snapCounters() {
  return { ...counters };
}

export async function health() {
  const summary = {
    enabled: config.enabled,
    wsEnabled: config.wsEnabled,
    dryRun: config.dryRun,
    secretConfigured: secrets.length > 0,
    queue: { pending: 0, deadLetter: 0 },
    counters: snapCounters(),
    moodleReachable: false,
    checks: { config: "pass" },
  };
  try {
    summary.queue.pending = await SyncJob.countDocuments({ status: "pending" });
    summary.queue.deadLetter = await SyncJob.countDocuments({ status: "dead_letter" });
  } catch (e) { summary.checks.mongo = "fail"; }

  if (config.wsEnabled && !config.dryRun && config.wsToken) {
    try {
      await client.getUsersByField("id", ["0"]); // cheap / harmless lookup
      summary.moodleReachable = true;
    } catch (err) {
      summary.moodleReachable = false;
      summary.checks.moodle = err.message;
    }
  }
  return summary;
}

export default { bump, snapCounters, health };