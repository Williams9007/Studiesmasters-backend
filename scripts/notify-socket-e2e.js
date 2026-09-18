// scripts/notify-socket-e2e.js
//
// Live over-the-wire check of the timetable notification path:
//   - a real Socket.IO server wired EXACTLY like server.js
//     (handshakeIdentity + joinRoleRooms + notify.js via setSocketIO)
//   - real Socket.IO clients acting as a student, a teacher and a tutor manager
//
// Proves that "New Class Added to Your Timetable" / "Timetable published" emits
// actually land on the right client and never leak to the other role.
//
// Run with: npm run test:notify-socket
import assert from "assert";
import http from "http";
import { Server } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { joinRoleRooms, handshakeIdentity } from "../utils/socketRooms.js";
import { setSocketIO, emitToStudent, emitToTeacher, emitToAllTeachers, emitToQaos } from "../services/qao/notify.js";

const STUDENT_ID = "68b0000000000000000000aa";
const TEACHER_ID = "68b0000000000000000000bb";
const QAO_ID = "68b0000000000000000000dd";
const OTHER_STUDENT = "68b0000000000000000000ee";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
};

const EVENT_NAMES = ["notification:new", "timetable:published", "class:created", "class:upcoming", "new-broadcast"];
const emptyBucket = () => Object.fromEntries(EVENT_NAMES.map((e) => [e, []]));

const run = async () => {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });

  // ── EXACT wiring of server.js's io.on("connection") ────────────────────────
  io.on("connection", (socket) => {
    const { userId, role } = handshakeIdentity(socket);
    joinRoleRooms(socket, role, userId);
    socket.on("student-join", (id) => joinRoleRooms(socket, "student", id || userId));
    socket.on("teacher-join", (id) => joinRoleRooms(socket, "teacher", id || userId));
    socket.on("qao-join", (id) => joinRoleRooms(socket, "qao", id || userId));
    socket.on("admin-join", (id) => joinRoleRooms(socket, "admin", id || userId));
  });
  setSocketIO(io);

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `http://localhost:${port}`;

  const received = { student: emptyBucket(), teacher: emptyBucket(), qao: emptyBucket() };

  const student = ioClient(url, {
    auth: { role: "student", userId: STUDENT_ID },
    query: { role: "student", userId: STUDENT_ID },
    transports: ["websocket"],
  });
  const teacher = ioClient(url, {
    auth: { role: "teacher", userId: TEACHER_ID },
    query: { role: "teacher", userId: TEACHER_ID },
    transports: ["websocket"],
  });
  const qao = ioClient(url, { auth: { role: "qao", userId: QAO_ID }, transports: ["websocket"] });

  student.onAny((event, payload) => { if (received.student[event]) received.student[event].push(payload); });
  teacher.onAny((event, payload) => { if (received.teacher[event]) received.teacher[event].push(payload); });
  qao.onAny((event, payload) => { if (received.qao[event]) received.qao[event].push(payload); });

  await Promise.all([
    new Promise((r) => student.on("connect", r)),
    new Promise((r) => teacher.on("connect", r)),
    new Promise((r) => qao.on("connect", r)),
  ]);
  await wait(200); // let the server-side room joins settle

  console.log("\n[1] per-session timetable notification (createSession path)");
  emitToStudent(STUDENT_ID, "notification:new", { title: "New Class Added to Your Timetable", message: "Maths (JHS 1)" });
  emitToTeacher(TEACHER_ID, "notification:new", { title: "New Class Scheduled", message: "Maths (JHS 1)" });
  await wait(300);

  check("student receives their class notification", () => {
    assert.strictEqual(received.student["notification:new"].length, 1);
    assert.strictEqual(received.student["notification:new"][0].title, "New Class Added to Your Timetable");
  });
  check("teacher receives their class notification", () => {
    assert.strictEqual(received.teacher["notification:new"].length, 1);
    assert.strictEqual(received.teacher["notification:new"][0].title, "New Class Scheduled");
  });
  check("teacher does NOT receive the student's notification", () => {
    assert.ok(!received.teacher["notification:new"].some((p) => p.title === "New Class Added to Your Timetable"));
  });

  console.log("\n[2] published-timetable summary (generateRangeSessions path)");
  emitToStudent(OTHER_STUDENT, "notification:new", { title: "Timetable published" });
  emitToTeacher(TEACHER_ID, "timetable:published", { classGroup: "SM-MATH-JHS1", count: 12 });
  emitToQaos("timetable:published", { classGroup: "SM-MATH-JHS1", count: 12 });
  await wait(300);

  check("teacher receives timetable:published", () => {
    assert.strictEqual(received.teacher["timetable:published"].length, 1);
    assert.strictEqual(received.teacher["timetable:published"][0].count, 12);
  });
  check("qao room receives timetable:published", () => {
    assert.strictEqual(received.qao["timetable:published"].length, 1);
  });
  check("student does not receive the teacher/QAO event", () => {
    assert.strictEqual(received.student["timetable:published"].length, 0);
  });
  check("another student's notification is not delivered to this student", () => {
    assert.strictEqual(received.student["notification:new"].length, 1);
  });

  console.log("\n[3] role-room broadcast + legacy student room (admin broadcasts)");
  emitToAllTeachers("class:upcoming", { sessionId: "s1" });
  io.to(STUDENT_ID).emit("new-broadcast", { message: "School closes early today" });
  await wait(300);

  check("all-teachers broadcast reaches the teacher", () => {
    assert.strictEqual(received.teacher["class:upcoming"].length, 1);
  });
  check("all-teachers broadcast does NOT reach the student", () => {
    assert.strictEqual(received.student["class:upcoming"].length, 0);
  });
  check("legacy bare-room student broadcast reaches the student", () => {
    assert.strictEqual(received.student["new-broadcast"].length, 1);
    assert.strictEqual(received.student["new-broadcast"][0].message, "School closes early today");
  });

  student.disconnect();
  teacher.disconnect();
  qao.disconnect();
  io.close();
  await new Promise((r) => httpServer.close(r));

  console.log(failures === 0 ? "\nAll live socket delivery checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error("Socket E2E crashed:", err);
  process.exit(1);
});