// tests/moodle-dashboard-auth.test.js
//
// Security suite for the dashboard READ API shared by the Moodle presentation
// layer and the React app. Verifies token auth, signed identity claims,
// cross-user/cross-role isolation and replay protection — against the REAL
// route modules mounted in a throwaway Express app (no database required,
// because every rejected request is stopped by the middleware).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";

import studentRoutes from "../routes/studentRoutes.js";
import teacherRoutes from "../routes/teacherRoutes.js";
import { dashboardReadAuth } from "../middleware/dashboardAuth.js";
import {
  parseIdentity,
  signIdentityClaim,
  verifyIdentityClaim,
  verifyDashboardToken,
  resetDashboardNonceStore,
} from "../services/moodle/dashboardAuth.js";

const TOKEN = "test-moodle-dashboard-token-0123456789";
const JWT_SECRET = "test-jwt-secret";

const STUDENT_A = { id: "6a62082fd5d62eeb1d0f2e79", identity: "sm_s_6a62082fd5d62eeb1d0f2e79" };
const STUDENT_B = { id: "6a624535fe7acb5750ffd362", identity: "sm_s_6a624535fe7acb5750ffd362" };
const TEACHER_A = { id: "6a82f8d4806c9700bf489173", identity: "sm_t_6a82f8d4806c9700bf489173" };
const TEACHER_B = { id: "6a621e038fefb45080ea83a8", identity: "sm_t_6a621e038fefb45080ea83a8" };

/** Set env vars for a block and restore them afterwards. */
function withEnv(vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const baseEnv = () => withEnv({
  MOODLE_DASHBOARD_TOKEN: TOKEN,
  MOODLE_DASHBOARD_AUTH_MODE: "enforce",
  MOODLE_DASHBOARD_NONCE_STORE: "memory",
  MOODLE_DASHBOARD_CLOCK_SKEW: "300",
  JWT_SECRET,
});

/** Signed Moodle identity claim headers. */
function moodleHeaders({ method, path, identity, timestamp, nonce, secret = TOKEN }) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const n = nonce ?? crypto.randomUUID();
  return {
    Authorization: `Bearer ${secret}`,
    "X-Moodle-Identity": identity,
    "X-Moodle-Timestamp": String(ts),
    "X-Moodle-Nonce": n,
    "X-Moodle-Signature": signIdentityClaim({ method, path, identity, timestamp: ts, nonce: n, secret }),
  };
}

/** Throwaway app: REAL routers (wiring proof) + stub routes (pass-through proof). */
async function startServer() {
  const app = express();
  app.use(express.json());
  app.use("/api/students", studentRoutes);
  app.use("/api/teachers", teacherRoutes);
  // Stubs let a valid credential reach a handler without touching Mongo.
  app.get("/api/students/:studentId/ok", dashboardReadAuth({ role: "student", idParam: "studentId", label: "stub" }),
    (req, res) => res.json({ success: true, stub: "student", auth: req.dashboardAuth }));
  app.get("/api/teachers/:id/ok", dashboardReadAuth({ role: "teacher", idParam: "id", label: "stub" }),
    (req, res) => res.json({ success: true, stub: "teacher", auth: req.dashboardAuth }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

const get = (url, headers = {}) => fetch(url, { headers });

// ---------------------------------------------------------------------------
// Token verification (unit)
// ---------------------------------------------------------------------------

test("bearer token fails closed and validates timing-safely", () => {
  const restore = withEnv({ MOODLE_DASHBOARD_TOKEN: undefined });
  try {
    assert.deepEqual(verifyDashboardToken("anything"), { ok: false, reason: "not_configured" });
    process.env.MOODLE_DASHBOARD_TOKEN = "replace-with-a-long-random-shared-token";
    assert.deepEqual(verifyDashboardToken("replace-with-a-long-random-shared-token"), { ok: false, reason: "not_configured" });
    process.env.MOODLE_DASHBOARD_TOKEN = "short";
    assert.deepEqual(verifyDashboardToken("short"), { ok: false, reason: "not_configured" });
    process.env.MOODLE_DASHBOARD_TOKEN = TOKEN;
    assert.deepEqual(verifyDashboardToken(""), { ok: false, reason: "missing_token" });
    assert.deepEqual(verifyDashboardToken("wrong"), { ok: false, reason: "invalid_token" });
    assert.deepEqual(verifyDashboardToken(`${TOKEN}x`), { ok: false, reason: "invalid_token" });
    assert.deepEqual(verifyDashboardToken(TOKEN), { ok: true });
  } finally {
    restore();
  }
});

test("identity strings are parsed into role + platform id", () => {
  assert.deepEqual(parseIdentity(STUDENT_A.identity), { role: "student", platformId: STUDENT_A.id });
  assert.deepEqual(parseIdentity(TEACHER_A.identity), { role: "teacher", platformId: TEACHER_A.id });
  assert.equal(parseIdentity("sm_x_6a62082fd5d62eeb1d0f2e79"), null);
  assert.equal(parseIdentity("6a62082fd5d62eeb1d0f2e79"), null);
  assert.equal(parseIdentity(""), null);
});

// ---------------------------------------------------------------------------
// Signed identity claim (unit)
// ---------------------------------------------------------------------------

test("valid claim verifies; tampering/drift/replay fields are rejected", () => {
  const restore = baseEnv();
  try {
    const path = `/api/students/${STUDENT_A.id}/timetable`;
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const nonce = crypto.randomUUID();
    const signature = signIdentityClaim({
      method: "GET", path, identity: STUDENT_A.identity, timestamp: ts, nonce, secret: TOKEN,
    });

    const ok = verifyIdentityClaim({
      method: "GET", path, identity: STUDENT_A.identity, timestamp: ts, nonce, signature, now,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.role, "student");
    assert.equal(ok.platformId, STUDENT_A.id);

    // Claim minted for A, replayed against B's path or B's identity.
    const otherPath = verifyIdentityClaim({
      method: "GET", path: `/api/students/${STUDENT_B.id}/timetable`,
      identity: STUDENT_A.identity, timestamp: ts, nonce, signature, now,
    });
    assert.deepEqual(otherPath, { ok: false, reason: "invalid_signature" });

    const otherIdentity = verifyIdentityClaim({
      method: "GET", path, identity: STUDENT_B.identity, timestamp: ts, nonce, signature, now,
    });
    assert.deepEqual(otherIdentity, { ok: false, reason: "invalid_signature" });

    // Method is part of the signature.
    const otherMethod = verifyIdentityClaim({
      method: "POST", path, identity: STUDENT_A.identity, timestamp: ts, nonce, signature, now,
    });
    assert.deepEqual(otherMethod, { ok: false, reason: "invalid_signature" });

    // Stale timestamp (older than the 300s skew).
    const staleTs = ts - 4000;
    const staleSignature = signIdentityClaim({
      method: "GET", path, identity: STUDENT_A.identity, timestamp: staleTs, nonce, secret: TOKEN,
    });
    assert.deepEqual(
      verifyIdentityClaim({ method: "GET", path, identity: STUDENT_A.identity, timestamp: staleTs, nonce, signature: staleSignature, now }),
      { ok: false, reason: "stale_request" }
    );

    // Missing pieces.
    assert.deepEqual(
      verifyIdentityClaim({ method: "GET", path, identity: STUDENT_A.identity, timestamp: ts, nonce: "", signature, now }),
      { ok: false, reason: "missing_nonce" }
    );
    assert.deepEqual(
      verifyIdentityClaim({ method: "GET", path, identity: STUDENT_A.identity, timestamp: ts, nonce, signature: "", now }),
      { ok: false, reason: "missing_signature" }
    );
    assert.deepEqual(
      verifyIdentityClaim({ method: "GET", path, identity: STUDENT_A.identity, timestamp: "", nonce, signature, now }),
      { ok: false, reason: "missing_timestamp" }
    );

    // Millisecond timestamps are accepted.
    const msSignature = signIdentityClaim({
      method: "GET", path, identity: STUDENT_A.identity, timestamp: now, nonce, secret: TOKEN,
    });
    assert.equal(verifyIdentityClaim({
      method: "GET", path, identity: STUDENT_A.identity, timestamp: now, nonce, signature: msSignature, now,
    }).ok, true);
  } finally {
    restore();
  }
});

test("claim verification refuses to run without a configured token", () => {
  const restore = withEnv({ MOODLE_DASHBOARD_TOKEN: undefined });
  try {
    const result = verifyIdentityClaim({
      method: "GET", path: "/api/students/x/timetable", identity: STUDENT_A.identity,
      timestamp: Math.floor(Date.now() / 1000), nonce: "n", signature: "s",
    });
    assert.deepEqual(result, { ok: false, reason: "not_configured" });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP-level enforcement (real routers mounted)
// ---------------------------------------------------------------------------

test("dashboard read endpoints over HTTP: 401 / 403 / 200 matrix", async (t) => {
  const restore = baseEnv();
  resetDashboardNonceStore();
  const server = await startServer();
  t.after(async () => {
    await server.close();
    restore();
  });

  const studentPath = `/api/students/${STUDENT_A.id}/timetable`;
  const teacherPath = `/api/teachers/${TEACHER_A.id}/timetable`;

  // ---- 401: no credential ------------------------------------------------
  for (const path of [studentPath, teacherPath, `/api/teachers/${TEACHER_A.id}/performance`,
      `/api/teachers/${TEACHER_A.id}/notifications`, `/api/students/${STUDENT_A.id}/notifications`,
      `/api/students/broadcasts/${STUDENT_A.id}`, `/api/teachers/teacher/broadcasts/${TEACHER_A.id}`]) {
    const res = await get(server.base + path);
    assert.equal(res.status, 401, `${path} without a token must be 401`);
    assert.equal((await res.json()).code, "UNAUTHORIZED");
  }

  // ---- 401: invalid token -------------------------------------------------
  const badToken = await get(server.base + studentPath, { Authorization: "Bearer not-the-token" });
  assert.equal(badToken.status, 401);

  // ---- 401: valid token but no identity claim ----------------------------
  const noClaim = await get(server.base + studentPath, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(noClaim.status, 401);
  assert.equal((await noClaim.json()).code, "UNAUTHORIZED");

  // ---- 200 via stub: valid token + valid claim (proves pass-through) ------
  const studentOk = await get(
    `${server.base}/api/students/${STUDENT_A.id}/ok`,
    moodleHeaders({ method: "GET", path: `/api/students/${STUDENT_A.id}/ok`, identity: STUDENT_A.identity })
  );
  assert.equal(studentOk.status, 200);
  assert.equal((await studentOk.json()).auth.kind, "moodle");

  const teacherOk = await get(
    `${server.base}/api/teachers/${TEACHER_A.id}/ok`,
    moodleHeaders({ method: "GET", path: `/api/teachers/${TEACHER_A.id}/ok`, identity: TEACHER_A.identity })
  );
  assert.equal(teacherOk.status, 200);
  assert.equal((await teacherOk.json()).auth.role, "teacher");

  // ---- 403: student A asking for student B -------------------------------
  const crossStudent = await get(
    server.base + `/api/students/${STUDENT_B.id}/timetable`,
    moodleHeaders({ method: "GET", path: `/api/students/${STUDENT_B.id}/timetable`, identity: STUDENT_A.identity })
  );
  assert.equal(crossStudent.status, 403);
  assert.equal((await crossStudent.json()).code, "FORBIDDEN");

  // ---- 403: teacher A asking for teacher B -------------------------------
  const crossTeacher = await get(
    server.base + `/api/teachers/${TEACHER_B.id}/performance`,
    moodleHeaders({ method: "GET", path: `/api/teachers/${TEACHER_B.id}/performance`, identity: TEACHER_A.identity })
  );
  assert.equal(crossTeacher.status, 403);

  // ---- 403: student credential on a teacher endpoint ---------------------
  const roleSwapIn = await get(
    server.base + teacherPath,
    moodleHeaders({ method: "GET", path: teacherPath, identity: STUDENT_A.identity })
  );
  assert.equal(roleSwapIn.status, 403);

  // ---- 403: teacher credential on a student endpoint ---------------------
  const roleSwapOut = await get(
    server.base + studentPath,
    moodleHeaders({ method: "GET", path: studentPath, identity: TEACHER_A.identity })
  );
  assert.equal(roleSwapOut.status, 403);

  // ---- 403: student id smuggled into a teacher URL -----------------------
  const studentOnTeacherRoute = await get(
    server.base + `/api/teachers/${STUDENT_A.id}/timetable`,
    moodleHeaders({ method: "GET", path: `/api/teachers/${STUDENT_A.id}/timetable`, identity: STUDENT_A.identity })
  );
  assert.equal(studentOnTeacherRoute.status, 403);

  // ---- 401: replayed nonce ----------------------------------------------
  const replayPath = `/api/students/${STUDENT_A.id}/ok`;
  const nonce = crypto.randomUUID();
  const headers = moodleHeaders({ method: "GET", path: replayPath, identity: STUDENT_A.identity, nonce });
  const first = await get(server.base + replayPath, headers);
  assert.equal(first.status, 200);
  const second = await get(server.base + replayPath, headers);
  assert.equal(second.status, 401, "a replayed nonce must be rejected");

  // ---- 401: stale claim --------------------------------------------------
  const staleTs = Math.floor(Date.now() / 1000) - 4000;
  const stalePath = `/api/students/${STUDENT_A.id}/ok`;
  const stale = await get(server.base + stalePath, moodleHeaders({
    method: "GET", path: stalePath, identity: STUDENT_A.identity, timestamp: staleTs,
  }));
  assert.equal(stale.status, 401);

  // ---- 401: signature minted with the wrong secret -----------------------
  const wrongSecretPath = `/api/students/${STUDENT_A.id}/ok`;
  const forged = await get(server.base + wrongSecretPath, moodleHeaders({
    method: "GET", path: wrongSecretPath, identity: STUDENT_A.identity, secret: "some-other-secret-value",
  }));
  assert.equal(forged.status, 401);
});

test("React platform JWTs still work and are identity/role scoped", async (t) => {
  const restore = baseEnv();
  const server = await startServer();
  t.after(async () => {
    await server.close();
    restore();
  });

  const sign = (payload, options = {}) => jwt.sign(payload, JWT_SECRET, { expiresIn: "5m", ...options });
  const studentJwt = sign({ id: STUDENT_A.id, role: "student", email: "a@example.com" });
  const teacherJwt = sign({ id: TEACHER_A.id, role: "teacher", email: "t@example.com" });

  // Happy path: the browser's own session token reaches the handler.
  const own = await get(`${server.base}/api/students/${STUDENT_A.id}/ok`, { Authorization: `Bearer ${studentJwt}` });
  assert.equal(own.status, 200);
  const ownBody = await own.json();
  assert.equal(ownBody.auth.kind, "jwt");

  const ownTeacher = await get(`${server.base}/api/teachers/${TEACHER_A.id}/ok`, { Authorization: `Bearer ${teacherJwt}` });
  assert.equal(ownTeacher.status, 200);

  // 403: a valid student JWT asked to read another student.
  const otherStudent = await get(`${server.base}/api/students/${STUDENT_B.id}/timetable`, {
    Authorization: `Bearer ${studentJwt}`,
  });
  assert.equal(otherStudent.status, 403);
  assert.equal((await otherStudent.json()).code, "FORBIDDEN");

  // 403: a valid teacher JWT asked to read another teacher.
  const otherTeacher = await get(`${server.base}/api/teachers/${TEACHER_B.id}/timetable`, {
    Authorization: `Bearer ${teacherJwt}`,
  });
  assert.equal(otherTeacher.status, 403);

  // 403: role confusion in both directions.
  const studentOnTeacher = await get(`${server.base}/api/teachers/${TEACHER_A.id}/ok`, {
    Authorization: `Bearer ${studentJwt}`,
  });
  assert.equal(studentOnTeacher.status, 403);
  const teacherOnStudent = await get(`${server.base}/api/students/${STUDENT_A.id}/ok`, {
    Authorization: `Bearer ${teacherJwt}`,
  });
  assert.equal(teacherOnStudent.status, 403);

  // 401: expired / foreign JWT.
  const expired = sign({ id: STUDENT_A.id, role: "student" }, { expiresIn: "-1s" });
  assert.equal((await get(`${server.base}/api/students/${STUDENT_A.id}/ok`, {
    Authorization: `Bearer ${expired}`,
  })).status, 401);
  const foreign = jwt.sign({ id: STUDENT_A.id, role: "student" }, "a-different-secret-value");
  assert.equal((await get(`${server.base}/api/students/${STUDENT_A.id}/ok`, {
    Authorization: `Bearer ${foreign}`,
  })).status, 401);
});

test("legacy roleless student JWTs ({id} only) still reach their own student dashboard", async (t) => {
  const restore = baseEnv();
  const server = await startServer();
  t.after(async () => {
    await server.close();
    restore();
  });

  // /api/students/login has always minted `{ id }` tokens WITHOUT a role
  // claim; existing 7-day sessions must keep working after the dashboard-auth
  // rollout. A roleless token is only ever a student session.
  const legacy = jwt.sign({ id: STUDENT_A.id }, JWT_SECRET, { expiresIn: "5m" });

  const own = await get(`${server.base}/api/students/${STUDENT_A.id}/ok`, {
    Authorization: `Bearer ${legacy}`,
  });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).auth.kind, "jwt");

  // Still identity-scoped: another student's data stays forbidden.
  const other = await get(`${server.base}/api/students/${STUDENT_B.id}/timetable`, {
    Authorization: `Bearer ${legacy}`,
  });
  assert.equal(other.status, 403);

  // Still role-scoped: a roleless token is NOT a teacher session.
  const onTeacher = await get(`${server.base}/api/teachers/${TEACHER_A.id}/ok`, {
    Authorization: `Bearer ${legacy}`,
  });
  assert.equal(onTeacher.status, 403);
});

test("monitor mode logs but does not block (rollout switch)", async (t) => {
  const restore = baseEnv();
  process.env.MOODLE_DASHBOARD_AUTH_MODE = "monitor";
  const server = await startServer();
  t.after(async () => {
    await server.close();
    restore();
  });

  const res = await get(`${server.base}/api/students/${STUDENT_A.id}/ok`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).auth.kind, "monitor");
});