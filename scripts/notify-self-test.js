// scripts/notify-self-test.js
//
// Verifies the notification routing contract that the timetable feature relies
// on, without needing Mongo or a live HTTP server:
//
//   1. utils/socketRooms.js joins exactly the rooms that notify.js emits to.
//   2. every notify.js emit helper targets the correct room.
//   3. utils/sendTimetableEmail.js degrades gracefully with no RESEND_API_KEY.
//   4. the timetable/notification/scheduling services export their API.
//
// Run with: npm run test:notify
import assert from "assert";
import { joinRoleRooms, handshakeIdentity } from "../utils/socketRooms.js";
import {
  setSocketIO,
  emitToTeacher,
  emitToStudent,
  emitToStudents,
  emitToQaos,
  emitToAdmin,
  emitToAdmins,
  emitToAllTeachers,
} from "../services/qao/notify.js";
import { sendTimetableEmail, sendClassReminderEmail } from "../utils/sendTimetableEmail.js";

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

// Async variant for checks that await real service calls (e.g. push fan-out).
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
};

const fakeSocket = () => {
  const rooms = new Set();
  return { rooms, join: (room) => rooms.add(String(room)) };
};

const STUDENT_ID = "68b0000000000000000000aa";
const TEACHER_ID = "68b0000000000000000000bb";
const ADMIN_ID = "68b0000000000000000000cc";
const QAO_ID = "68b0000000000000000000dd";
const STUDENT_TWO = "68b0000000000000000000ee";

// ─── 1. Room joining ─────────────────────────────────────────────────────────

console.log("\n[1] socket room joins");
check("student joins student:{id} + legacy {id}", () => {
  const s = fakeSocket();
  joinRoleRooms(s, "student", STUDENT_ID);
  assert.ok(s.rooms.has(`student:${STUDENT_ID}`), "missing student:{id}");
  assert.ok(s.rooms.has(STUDENT_ID), "missing legacy {id} room");
});

check("teacher joins teachers + teacher:{id}", () => {
  const s = fakeSocket();
  joinRoleRooms(s, "teacher", TEACHER_ID);
  assert.ok(s.rooms.has("teachers"));
  assert.ok(s.rooms.has(`teacher:${TEACHER_ID}`));
});

check("qao joins qaos + qao:{id}", () => {
  const s = fakeSocket();
  joinRoleRooms(s, "qao", QAO_ID);
  assert.ok(s.rooms.has("qaos"));
  assert.ok(s.rooms.has(`qao:${QAO_ID}`));
});

check("admin joins admins + admin:{id}", () => {
  const s = fakeSocket();
  joinRoleRooms(s, "admin", ADMIN_ID);
  assert.ok(s.rooms.has("admins"));
  assert.ok(s.rooms.has(`admin:${ADMIN_ID}`));
});

check("unknown role / missing id joins nothing", () => {
  const s = fakeSocket();
  joinRoleRooms(s, "ghost", STUDENT_ID);
  joinRoleRooms(s, "student", null);
  assert.strictEqual(s.rooms.size, 0);
});

check("handshakeIdentity prefers auth over query", () => {
  const identity = handshakeIdentity({
    handshake: { query: { userId: "q1", role: "student" }, auth: { userId: "a1", role: "TEACHER" } },
  });
  assert.deepStrictEqual(identity, { userId: "a1", role: "teacher" });
});

// ─── 2. Emit targets ─────────────────────────────────────────────────────────

const calls = [];
setSocketIO({
  to: (room) => ({ emit: (event, payload) => calls.push({ room, event, payload }) }),
});

console.log("\n[2] notify.js emit targets");
check("emitToTeacher -> teacher:{id}", () => {
  calls.length = 0;
  emitToTeacher(TEACHER_ID, "notification:new", { a: 1 });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].room, `teacher:${TEACHER_ID}`);
});

check("emitToStudent -> student:{id}", () => {
  calls.length = 0;
  emitToStudent(STUDENT_ID, "notification:new", { a: 1 });
  assert.strictEqual(calls[0].room, `student:${STUDENT_ID}`);
});

check("emitToStudents -> one emit per student room", () => {
  calls.length = 0;
  emitToStudents([STUDENT_ID, STUDENT_TWO], "notification:new", { a: 1 });
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls.map((c) => c.room), [`student:${STUDENT_ID}`, `student:${STUDENT_TWO}`]);
});

check("emitToStudents supports a payload mapper (userId lookup)", () => {
  calls.length = 0;
  const docs = [{ userId: STUDENT_ID, _id: "n1" }];
  emitToStudents([STUDENT_ID], "notification:new", (studentId) => {
    const doc = docs.find((d) => String(d.userId) === String(studentId));
    return { notificationId: doc?._id };
  });
  assert.deepStrictEqual(calls[0].payload, { notificationId: "n1" });
});

check("emitToQaos -> qaos room", () => {
  calls.length = 0;
  emitToQaos("timetable:published", {});
  assert.strictEqual(calls[0].room, "qaos");
});

check("emitToAdmin -> admins room", () => {
  calls.length = 0;
  emitToAdmin("class:live", {});
  assert.strictEqual(calls[0].room, "admins");
});

check("emitToAdmins -> admin:{id}", () => {
  calls.length = 0;
  emitToAdmins(ADMIN_ID, "class:live", {});
  assert.strictEqual(calls[0].room, `admin:${ADMIN_ID}`);
});

check("emitToAllTeachers -> teachers room", () => {
  calls.length = 0;
  emitToAllTeachers("notification:new", {});
  assert.strictEqual(calls[0].room, "teachers");
});

// ── 3. Email helpers degrade gracefully ─────────────────────────────────────

console.log("\n[3] email helpers (no RESEND_API_KEY required)");

const run = async () => {
  const missingKey = !process.env.RESEND_API_KEY;

  const timetable = await sendTimetableEmail({ to: "student@example.com", entries: [] });
  check("sendTimetableEmail never throws", () => {
    assert.strictEqual(typeof timetable.sent, "boolean");
    if (missingKey) {
      assert.strictEqual(timetable.sent, false);
      assert.ok(timetable.skipped, "expected a 'skipped' reason without RESEND_API_KEY");
    }
  });

  const noRecipient = await sendTimetableEmail({ to: "", entries: [] });
  check("sendTimetableEmail skips with no recipient", () => {
    assert.strictEqual(noRecipient.sent, false);
  });

  const reminder = await sendClassReminderEmail({ to: "student@example.com" });
  check("sendClassReminderEmail is opt-in", () => {
    assert.strictEqual(reminder.sent, false);
    assert.ok(String(reminder.skipped || "").length > 0);
  });

  // ─── 4. Module surface ────────────────────────────────────────────────────

  console.log("\n[4] service module exports");
  const timetableSvc = await import("../services/timetable.service.js");
  check("timetable.service exports publishTimetable", () => {
    assert.strictEqual(typeof timetableSvc.publishTimetable, "function");
    assert.strictEqual(typeof timetableSvc.generateRangeSessions, "function");
    assert.strictEqual(typeof timetableSvc.saveWeeklySlots, "function");
  });

  const notifSvc = await import("../services/qao/notification.service.js");
  check("notification.service exports the full API", () => {
    for (const fn of [
      "createNotification",
      "notifyTeacher",
      "notifyStudent",
      "notifyStudents",
      "notifyAllTeachers",
      "notifyAllQaos",
      "listForUser",
      "markRead",
      "markAllRead",
      "unreadCount",
      "listForQao",
      "markReadQao",
      "markAllReadQao",
      "unreadCountQao",
    ]) {
      assert.strictEqual(typeof notifSvc[fn], "function", `${fn} is missing`);
    }
  });

  const scheduling = await import("../services/qao/scheduling.service.js");
  check("scheduling.service exports createSession", () => {
    assert.strictEqual(typeof scheduling.createSession, "function");
  });

  // ─── 5. Push helpers used by the timetable flows ───────────────────────────

  console.log("\n[5] push notification helpers");
  const push = await import("../Controllers/pushNotificationController.js");
  check("push controller exports the targeted + broadcast helpers", () => {
    for (const fn of ["sendPushToAll", "sendPushToTeacher", "sendPushToStudents", "sendPushToQaos"]) {
      assert.strictEqual(typeof push[fn], "function", `${fn} is missing`);
    }
  });

  await checkAsync("targeted pushes resolve without subscribers (no throw)", async () => {
    const teacher = await push.sendPushToTeacher(TEACHER_ID, "New Class Scheduled", "Math on Monday");
    const students = await push.sendPushToStudents([STUDENT_ID, STUDENT_TWO], "New Class Added", "Math on Monday");
    const qaos = await push.sendPushToQaos("Timetable submitted for review", "Mr Mensah: Math (JHS 2)");
    for (const r of [teacher, students, qaos]) {
      assert.strictEqual(typeof r.sent, "number");
      assert.strictEqual(typeof r.errors, "number");
    }
  });

  // Broadcast leg used by publishTimetable(), createSession() and the System
  // Guard alert service — must resolve (not throw) with zero subscribers.
  await checkAsync("sendPushToAll broadcast resolves without subscribers (no throw)", async () => {
    const all = await push.sendPushToAll("Timetable published", "JHS 2: 2 classes from 2026-01-05 to 2026-01-09.");
    assert.strictEqual(typeof all.sent, "number");
    assert.strictEqual(typeof all.errors, "number");
    assert.strictEqual(typeof all.totalSubscriptions, "number");
  });

  console.log(failures === 0 ? "\nAll notification routing checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error("Self-test crashed:", err);
  process.exit(1);
});