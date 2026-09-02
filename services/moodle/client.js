// services/moodle/client.js
//
// Moodle REST Web Services client. The Node backend is the ONLY authority that
// manages Moodle accounts; these low-level functions talk to Moodle's
// webservice/rest using core_user_* / core_enrol_* / course_* functions.
//
// Resilience:
//   - transient (network / 5xx / 429) failures are retried with backoff
//   - contextual errors are normalised into a MoodleWsError with a `transient` flag
//   - a true non-transient/4xx error is NOT blindly retried
//   - dry-run mode (MOODLE_DRY_RUN=true, the default) never touches a live Moodle
//     and returns a simulated success so the platform runs offline end-to-end.
import axios from "axios";
import { config } from "./config.js";
import logger from "../../utils/logger.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MoodleWsError extends Error {
  constructor(message, { code = "MOODLE_WS_ERROR", transient = false, data = null } = {}) {
    super(message);
    this.name = "MoodleWsError";
    this.code = code;
    this.transient = transient;
    this.data = data;
  }
}

function isTransientErr(err) {
  if (!err) return false;
  if (err.response) return err.response.status >= 500 || err.response.status === 429;
  return true; // network / timeouts / DNS / refused
}

function parseBody(raw) {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return { exception: raw.slice(0, 300) }; }
  }
  return raw;
}

/**
 * Invoke a Moodle WS function.
 * @param {string} wsfunction e.g. "core_user_create_users"
 * @param {object} params     flat (already-wrapped) query params for the REST call
 * @returns {Promise<any>}
 */
export async function callWs(wsfunction, params = {}) {
  if (config.dryRun) {
    logger.info(`[MOODLE dry-run] ${wsfunction}`, Object.keys(params));
    return { dryRun: true, function: wsfunction, id: null };
  }
  if (!config.wsEnabled) {
    throw new MoodleWsError("MOODLE_WS_ENABLED=false and MOODLE_DRY_RUN=false. Cannot reach Moodle.", {
      code: "MOODLE_WS_DISABLED", transient: false,
    });
  }
  if (!config.wsToken) {
    throw new MoodleWsError("MOODLE_WS_TOKEN is not set. Refusing to call a live Moodle.", {
      code: "MOODLE_WS_NOT_CONFIGURED", transient: false,
    });
  }

  const query = new URLSearchParams({ wstoken: config.wsToken, moodlewsrestformat: "json", wsfunction, ...params });
  let lastErr = null;

  for (let attempt = 1; attempt <= config.wsRetries; attempt += 1) {
    try {
      const resp = await axios.get(`${config.wsUrl}?${query.toString()}`, {
        timeout: config.wsTimeoutMs,
        headers: { Accept: "application/json" },
      });
      const body = parseBody(resp.data);
      if (body && typeof body === "object" && body.exception) {
        throw new MoodleWsError(
          `Moodle WS '${wsfunction}' fault: ${body.message || body.errorcode || "unknown"}`,
          { code: "MOODLE_WS_APPLICATION", transient: false, data: body }
        );
      }
      logger.debug("Moodle WS OK:", wsfunction, resp.status);
      return body;
    } catch (err) {
      lastErr = err;
      const transient = err instanceof MoodleWsError ? err.transient : isTransientErr(err);
      if (!transient) throw err; // 4xx / app error -> no retry
      if (attempt === config.wsRetries) break;
      const wait = config.wsRetryBackoffMs * 2 ** (attempt - 1);
      logger.warn(`[MOODLE] ${wsfunction} transient failure, retrying in ${wait}ms (${attempt}/${config.wsRetries}): ${err.message}`);
      await sleep(wait);
    }
  }

  if (lastErr instanceof MoodleWsError) throw lastErr;
  throw new MoodleWsError(`${wsfunction} failed after ${config.wsRetries} attempts: ${lastErr?.message}`, {
    code: "MOODLE_WS_RETRIES_EXHAUSTED", transient: true,
  });
}

// Core user/admin-ish operations used by the higher-level services.
export const client = {
  createUser(u) {
    return callWs("core_user_create_users",
      { "users[0][username]": u.username, "users[0][password]": u.password || "",
        "users[0][firstname]": u.firstname, "users[0][lastname]": u.lastname,
        "users[0][email]": u.email, "users[0][auth]": "manual",
        "users[0][idnumber]": u.idnumber || "", "users[0][confirmed]": 1 });
  },
  updateUser(id, fields) {
    const p = { "users[0][id]": id };
    for (const [k, v] of Object.entries(fields)) p[`users[0][${k}]`] = v;
    return callWs("core_user_update_users", p);
  },
  setSuspended(id, suspended) {
    return callWs("core_user_update_users", { "users[0][id]": id, suspended: suspended ? 1 : 0 });
  },
  enroll(entries) {
    const p = {};
    entries.forEach((e, i) => {
      p[`enrolments[${i}][courseid]`] = e.courseid;
      p[`enrolments[${i}][userid]`] = e.userid;
      if (e.roleid) p[`enrolments[${i}][roleid]`] = e.roleid;
    });
    return callWs("core_enrol_enrol_users", p);
  },
  unenroll(entries) {
    const p = {};
    entries.forEach((e, i) => {
      p[`enrolments[${i}][courseid]`] = e.courseid;
      p[`enrolments[${i}][userid]`] = e.userid;
    });
    return callWs("core_enrol_unenrol_users", p);
  },
  getUsersByField(field, values) {
    const p = { field };
    (values || []).forEach((v, i) => { p[`values[${i}]`] = v; });
    return callWs("core_user_get_users_by_field", p);
  },
  // ---- Category / course provisioning (idempotent via idnumber) -----------
  async getCategories(idnumbers) {
    const p = { criteria: [] };
    (idnumbers || []).forEach((v, i) => {
      p[`criteria[${i}][key]`] = "idnumber";
      p[`criteria[${i}][value]`] = v;
    });
    return callWs("core_course_get_categories", p);
  },
  createCategories(categories) {
    const p = {};
    (categories || []).forEach((c, i) => {
      p[`categories[${i}][name]`] = c.name;
      if (c.parent) p[`categories[${i}][parent]`] = c.parent;
      if (c.idnumber) p[`categories[${i}][idnumber]`] = c.idnumber;
      if (c.description) p[`categories[${i}][description]`] = c.description;
    });
    return callWs("core_course_create_categories", p);
  },
  async getCourses(idnumbers) {
    // core_course_get_courses without ids returns all courses; filter client-side
    // on idnumber (Moodle's WS cannot filter courses by idnumber directly).
    const list = await callWs("core_course_get_courses", {});
    const wanted = new Set(idnumbers || []);
    return (list || []).filter((c) => wanted.has(c.idnumber));
  },
  createCourses(courses) {
    const p = {};
    (courses || []).forEach((c, i) => {
      p[`courses[${i}][fullname]`] = c.fullname;
      p[`courses[${i}][shortname]`] = c.shortname;
      p[`courses[${i}][categoryid]`] = c.categoryid;
      p[`courses[${i}][idnumber]`] = c.idnumber;
      p[`courses[${i}][format]`] = c.format || "topics";
      p[`courses[${i}][visible]`] = 1;
    });
    return callWs("core_course_create_courses", p);
  },
};

export default client;