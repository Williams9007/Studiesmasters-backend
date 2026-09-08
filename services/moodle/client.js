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
      // POST form-encoded body (Moodle REST accepts it) — avoids HTTP 414
      // "URI Too Long" for large batch calls (e.g. creating many courses).
      const resp = await axios.post(config.wsUrl, query.toString(), {
        timeout: config.wsTimeoutMs,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        maxBodyLength: Infinity,
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
    // NOTE: Moodle 4.5+ rejects the "confirmed" key in core_user_create_users.
    return callWs("core_user_create_users",
      { "users[0][username]": u.username, "users[0][password]": u.password || "",
        "users[0][firstname]": u.firstname, "users[0][lastname]": u.lastname,
        "users[0][email]": u.email, "users[0][auth]": "manual",
        "users[0][idnumber]": u.idnumber || "" });
  },
  updateUser(id, fields) {
    const p = { "users[0][id]": id };
    for (const [k, v] of Object.entries(fields)) p[`users[0][${k}]`] = v;
    return callWs("core_user_update_users", p);
  },
  setSuspended(id, suspended) {
    return callWs("core_user_update_users", { "users[0][id]": id, suspended: suspended ? 1 : 0 });
  },
  // Enrolment function names differ across Moodle versions. Try the newest
  // registered names first, then fall back. Moodle 4.5 registers
  // enrol_manual_enrol_users / enrol_manual_unenrol_users.
  async _enrollCall(fns, p) {
    let lastErr = null;
    for (const fn of fns) {
      try {
        return await callWs(fn, p);
      } catch (err) {
        lastErr = err;
        if (err?.code === "MOODLE_WS_APPLICATION" && /invalidrecord|external_functions/i.test(err.message)) {
          continue; // function name not registered on this Moodle -> try next
        }
        throw err;
      }
    }
    throw lastErr;
  },
  enroll(entries) {
    const p = {};
    entries.forEach((e, i) => {
      p[`enrolments[${i}][courseid]`] = e.courseid;
      p[`enrolments[${i}][userid]`] = e.userid;
      // Moodle requires roleid; 5 = student (default "student" archetype role).
      p[`enrolments[${i}][roleid]`] = e.roleid || 5;
    });
    return this._enrollCall(["core_enrol_enrol_users", "enrol_manual_enrol_users", "enrol_users"], p);
  },
  unenroll(entries) {
    const p = {};
    entries.forEach((e, i) => {
      p[`enrolments[${i}][courseid]`] = e.courseid;
      p[`enrolments[${i}][userid]`] = e.userid;
      p[`enrolments[${i}][roleid]`] = e.roleid || 5;
      // Manual enrol method instance id (optional; Moodle falls back when omitted).
      if (e.enrolid) p[`enrolments[${i}][enrolid]`] = e.enrolid;
    });
    return this._enrollCall(["core_enrol_unenrol_users", "enrol_manual_unenrol_users", "unenrol_users"], p);
  },
  getUsersByField(field, values) {
    const p = { field };
    (values || []).forEach((v, i) => { p[`values[${i}]`] = v; });
    return callWs("core_user_get_users_by_field", p);
  },
  // Admin-level user search — not subject to per-course profile visibility,
  // unlike core_user_get_users_by_field. Requires core_user_get_users in the
  // WS service. Returns array of user objects (may be empty).
  async searchUsersByEmail(email) {
    try {
      const r = await callWs("core_user_get_users", { "criteria[0][key]": "email", "criteria[0][value]": email });
      if (r?.users?.length) return r.users;
    } catch { /* fall through to scan */ }
    // Fallback: some capability combinations hide email-search results, so
    // enumerate all users and match by fetching each by id (which does return
    // full details).
    try {
      const all = await callWs("core_user_get_users", { "criteria[0][key]": "", "criteria[0][value]": "" });
      const ids = (all?.users || []).map((u) => u.id).filter(Boolean);
      const needle = String(email || "").toLowerCase();
      for (const uid of ids) {
        try {
          const det = await callWs("core_user_get_users_by_field", { field: "id", "values[0]": String(uid) });
          const u = (det || [])[0];
          if (u && String(u.email || "").toLowerCase() === needle) return [u];
        } catch { /* skip user */ }
      }
    } catch { /* give up */ }
    return [];
  },
  // ---- Category / course provisioning (idempotent via idnumber) -----------
  async getCategories(idnumbers) {
    // Fetch ALL categories and filter client-side on idnumber — Moodle's WS
    // criteria filtering on "idnumber" is unreliable across versions, which
    // previously caused duplicate-category errors on re-provisioning.
    const list = await callWs("core_course_get_categories", {});
    const wanted = new Set(idnumbers || []);
    return (list || []).filter((c) => wanted.has(c.idnumber));
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