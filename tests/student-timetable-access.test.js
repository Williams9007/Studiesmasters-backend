// tests/student-timetable-access.test.js
//
// Proves the requirement from the brief: the backend is the single source of
// truth for timetable visibility and a student can NEVER see another class
// group's schedule or Google Meet link — not even when the two groups share the
// same grade, curriculum and subject.
//
//   Class Group A - "JHS 1 Mathematics Class 1", Monday 16:00
//   Class Group B - "JHS 1 Mathematics Class 2", Monday 18:00
//   Alice -> A.  Bob -> B.
//
// Runs against an in-memory MongoDB so it needs no external services.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import mongodbMemoryServer from "mongodb-memory-server";
const { MongoMemoryServer } = mongodbMemoryServer;

let access;
let Student;
let ClassGroup;
let ClassSession;

let mongo;
let teacherId;
let alice;
let bob;
let groupA;
let groupB;
let sessionA;
let sessionB;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  ({ default: access } = await import("../services/studentTimetableAccess.js"));
  ({ default: Student } = await import("../models/Student.js"));
  ({ default: ClassGroup } = await import("../models/ClassGroup.js"));
  ({ default: ClassSession } = await import("../models/ClassSession.js"));
  await import("../models/teacher.js");

  const teacher = await mongoose.connection.collection("teachers").insertOne({
    fullName: "Mr Mensah",
    email: "mensah@example.com",
  });
  teacherId = new mongoose.Types.ObjectId(teacher.insertedId);

  // Identical grade + curriculum + subject. ONLY the class-group membership
  // differs, which is exactly what must drive visibility.
  [alice, bob] = await Student.create([
    { userId: "SM-ST-ALICE", fullName: "Alice", email: "alice@example.com", phone: "1", password: "secret1", curriculum: "GES", grade: "JHS 1" },
    { userId: "SM-ST-BOB", fullName: "Bob", email: "bob@example.com", phone: "2", password: "secret2", curriculum: "GES", grade: "JHS 1" },
  ]);

  [groupA, groupB] = await ClassGroup.create([
    { code: "SM-MATH-JHS1-1", curriculum: "GES", grade: "JHS 1", subject: "Mathematics", capacity: 5, status: "active", students: [alice._id], teacher: teacherId, weeklySlots: [{ day: "Monday", startTime: "16:00", endTime: "17:00" }] },
    { code: "SM-MATH-JHS1-2", curriculum: "GES", grade: "JHS 1", subject: "Mathematics", capacity: 5, status: "active", students: [bob._id], teacher: teacherId, weeklySlots: [{ day: "Monday", startTime: "18:00", endTime: "19:00" }] },
  ]);

  const monday = new Date();
  monday.setUTCHours(0, 0, 0, 0);
  [sessionA, sessionB] = await ClassSession.create([
    { classGroup: groupA._id, teacher: teacherId, date: monday, startTime: "16:00", endTime: "17:00", status: "scheduled", meetingLink: "https://meet.google.com/aaa-aaa-aaa", meetingStatus: "ready" },
    { classGroup: groupB._id, teacher: teacherId, date: monday, startTime: "18:00", endTime: "19:00", status: "scheduled", meetingLink: "https://meet.google.com/bbb-bbb-bbb", meetingStatus: "ready" },
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

test("each student is assigned exactly their own class group", async () => {
  assert.deepEqual((await access.getAssignedClassGroupIds(alice._id)).map(String), [String(groupA._id)]);
  assert.deepEqual((await access.getAssignedClassGroupIds(bob._id)).map(String), [String(groupB._id)]);
});

test("Alice only ever receives 'JHS 1 Mathematics Class 1'", async () => {
  const { sessions, assignedGroupIds } = await access.loadStudentTimetable(alice._id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]._id.toString(), String(sessionA._id));
  assert.equal(sessions[0].classGroup.code, "SM-MATH-JHS1-1");
  assert.deepEqual(assignedGroupIds.map(String), [String(groupA._id)]);
});

test("Bob only ever receives 'JHS 1 Mathematics Class 2'", async () => {
  const { sessions } = await access.loadStudentTimetable(bob._id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]._id.toString(), String(sessionB._id));
  assert.equal(sessions[0].classGroup.code, "SM-MATH-JHS1-2");
});

test("identical grade/curriculum/subject never widens the result set", async () => {
  assert.equal(groupA.grade, groupB.grade);
  assert.equal(groupA.curriculum, groupB.curriculum);
  assert.equal(groupA.subject, groupB.subject);
  const aliceSessions = await access.loadStudentTimetable(alice._id);
  const bobSessions = await access.loadStudentTimetable(bob._id);
  const aliceIds = aliceSessions.sessions.map((s) => String(s._id));
  const bobIds = bobSessions.sessions.map((s) => String(s._id));
  assert.ok(!aliceIds.includes(String(sessionB._id)), "Alice must not receive Class Group B");
  assert.ok(!bobIds.includes(String(sessionA._id)), "Bob must not receive Class Group A");
});

test("every event carries its originating classGroupId", async () => {
  const { sessions, assignedGroupIds } = await access.loadStudentTimetable(alice._id);
  for (const s of sessions) {
    const gid = String(s.classGroup._id);
    assert.ok(assignedGroupIds.map(String).includes(gid), "classGroupId must be an assigned group");
  }
});

test("a student can only join (obtain the Meet link of) their OWN group's class", async () => {
  // Alice is in Class Group A: she may join Class 1, never Class 2.
  const aliceOwn = await access.assertSessionBelongsToStudent({ studentId: alice._id, sessionId: sessionA._id });
  assert.ok(aliceOwn, "Alice must be allowed to join her own class");
  assert.equal(String(aliceOwn.meetingLink), "https://meet.google.com/aaa-aaa-aaa");

  assert.equal(
    await access.assertSessionBelongsToStudent({ studentId: alice._id, sessionId: sessionB._id }),
    null,
    "Alice must never obtain Class Group B's Meet link",
  );
  assert.equal(
    await access.assertSessionBelongsToStudent({ studentId: bob._id, sessionId: sessionA._id }),
    null,
    "Bob must never obtain Class Group A's Meet link",
  );
  const bobOwn = await access.assertSessionBelongsToStudent({ studentId: bob._id, sessionId: sessionB._id });
  assert.ok(bobOwn, "Bob must be allowed to join his own class");
  assert.equal(String(bobOwn.meetingLink), "https://meet.google.com/bbb-bbb-bbb");

  // The same helper accepts the string id a route would pass, and rejects a
  // malformed one instead of casting it into a query.
  assert.ok(await access.assertSessionBelongsToStudent({ studentId: String(alice._id), sessionId: String(sessionA._id) }));
  assert.equal(await access.assertSessionBelongsToStudent({ studentId: alice._id, sessionId: "not-an-id" }), null);
});

test("a student with no class group gets an EMPTY timetable, not a fallback", async () => {
  const carol = await Student.create({ userId: "SM-ST-CAROL", fullName: "Carol", email: "carol@example.com", phone: "3", password: "secret3", curriculum: "GES", grade: "JHS 1" });
  const { sessions, assignedGroupIds } = await access.loadStudentTimetable(carol._id);
  assert.deepEqual(sessions, []);
  assert.deepEqual(assignedGroupIds, []);
  assert.equal(await access.studentSessionScope(carol._id), null);
});

test("a closed class group is no longer an active enrolment -> empty timetable", async () => {
  await ClassGroup.updateOne({ _id: groupA._id }, { status: "closed" });
  const { sessions } = await access.loadStudentTimetable(alice._id);
  assert.deepEqual(sessions, [], "closed group must not leak its schedule or Meet link");
  await ClassGroup.updateOne({ _id: groupA._id }, { status: "active" });
  assert.equal((await access.loadStudentTimetable(alice._id)).sessions.length, 1);
});

test("a curriculum or grade mismatch empties the timetable", async () => {
  await Student.updateOne({ _id: alice._id }, { grade: "JHS 2" });
  assert.deepEqual((await access.loadStudentTimetable(alice._id)).sessions, []);
  await Student.updateOne({ _id: alice._id }, { grade: "JHS 1", curriculum: "Cambridge" });
  assert.deepEqual((await access.loadStudentTimetable(alice._id)).sessions, []);
  await Student.updateOne({ _id: alice._id }, { curriculum: "GES" });
  assert.equal((await access.loadStudentTimetable(alice._id)).sessions.length, 1);
});

test("a student assigned to MULTIPLE groups receives exactly those groups' events", async () => {
  const dave = await Student.create({ userId: "SM-ST-DAVE", fullName: "Dave", email: "dave@example.com", phone: "4", password: "secret4", curriculum: "GES", grade: "JHS 1" });
  await ClassGroup.updateOne({ _id: groupA._id }, { $addToSet: { students: dave._id } });
  await ClassGroup.updateOne({ _id: groupB._id }, { $addToSet: { students: dave._id } });

  const { sessions, assignedGroupIds } = await access.loadStudentTimetable(dave._id);
  assert.equal(assignedGroupIds.length, 2, "both assignments are visible to him");
  assert.equal(sessions.length, 2, "he gets Class 1 AND Class 2, nothing else");
  assert.deepEqual(sessions.map((s) => String(s._id)).sort(), [String(sessionA._id), String(sessionB._id)].sort());

  await ClassGroup.updateOne({ _id: groupA._id }, { $pull: { students: dave._id } });
  await ClassGroup.updateOne({ _id: groupB._id }, { $pull: { students: dave._id } });
});

test("membership is mandatory: matching grade/curriculum/subject is not enough", async () => {
  const eve = await Student.create({ userId: "SM-ST-EVE", fullName: "Eve", email: "eve@example.com", phone: "6", password: "secret6", curriculum: "GES", grade: "JHS 1" });
  const outsider = await Student.create({ userId: "SM-ST-OUT", fullName: "Outsider", email: "out@example.com", phone: "7", password: "secret7", curriculum: "GES", grade: "JHS 1" });
  const [groupC] = await ClassGroup.create([
    { code: "SM-MATH-JHS1-3", curriculum: "GES", grade: "JHS 1", subject: "Mathematics", capacity: 5, status: "active", students: [eve._id] },
  ]);
  const sessionC = await ClassSession.create({ classGroup: groupC._id, teacher: teacherId, date: new Date(), startTime: "20:00", endTime: "21:00", status: "scheduled", meetingLink: "https://meet.google.com/ccc-ccc-ccc" });

  assert.deepEqual((await access.getAssignedClassGroupIds(eve._id)).map(String), [String(groupC._id)]);
  assert.deepEqual(await access.getAssignedClassGroupIds(outsider._id), [], "no membership -> no timetable");
  assert.equal((await access.loadStudentTimetable(outsider._id)).sessions.length, 0);
  assert.equal(await access.assertSessionBelongsToStudent({ studentId: outsider._id, sessionId: sessionC._id }), null);

  // Pure rule (no DB), so the gate itself is pinned even without fixtures.
  const base = { curriculum: "GES", grade: "JHS 1", status: "active", students: [eve._id] };
  assert.equal(access.passesAccessGates({ student: { _id: outsider._id, curriculum: "GES", grade: "JHS 1" }, group: { _id: groupC._id, ...base } }), false);
  assert.equal(access.passesAccessGates({ student: { _id: eve._id, curriculum: "GES", grade: "JHS 1" }, group: { _id: groupC._id, ...base } }), true);
  assert.equal(access.passesAccessGates({ student: { _id: eve._id, curriculum: "GES", grade: "JHS 1" }, group: { _id: groupC._id, ...base, status: "closed" } }), false);
  assert.equal(access.passesAccessGates({ student: { _id: eve._id, curriculum: "Cambridge", grade: "JHS 1" }, group: { _id: groupC._id, ...base } }), false);
});

test("an unknown or malformed student id resolves to nothing", async () => {
  assert.deepEqual(await access.getAssignedClassGroups(new mongoose.Types.ObjectId().toString()), []);
  assert.deepEqual(await access.getAssignedClassGroups("not-an-id"), []);
  assert.deepEqual(await access.getAssignedClassGroups(null), []);
});

test("a student only sees notifications for their own class group", async () => {
  const { listForUser, unreadCountForUser } = await import("../services/qao/notification.service.js");
  const Notification = (await import("../models/Notification.js")).default;

  // Three unread notices addressed to Alice: her own group's, ANOTHER group's
  // (e.g. a broadcast that ignored the gate), and a school-wide announcement.
  await Notification.create([
    { userId: alice._id, role: "student", title: "Class 1 reminder", message: "Your 16:00 class is tonight", classGroupId: groupA._id },
    { userId: alice._id, role: "student", title: "Class 2 reminder", message: "Your 18:00 class is tonight", classGroupId: groupB._id },
    { userId: alice._id, role: "student", title: "School announcement", message: "Term starts Monday", classGroupId: null },
    { userId: bob._id, role: "student", title: "Bob's class is live", message: "Class 2 started", classGroupId: groupB._id },
  ]);

  const notifications = await listForUser({ userId: alice._id, role: "student", limit: 50 });
  const titles = notifications.map((n) => n.title);
  assert.ok(titles.includes("Class 1 reminder"), "her own group's notice is shown");
  assert.ok(titles.includes("School announcement"), "school-wide notices are unaffected");
  assert.ok(!titles.includes("Class 2 reminder"), "another class group's notice must stay hidden");
  assert.ok(!titles.includes("Bob's class is live"), "and never a notice addressed to someone else");

  // The unread badge must agree with the filtered list, never over-count.
  assert.equal(await unreadCountForUser({ userId: alice._id, role: "student" }), notifications.filter((n) => !n.read).length);
});

test("class-group refs resolve from populated docs, bare ids and strings", () => {
  const gid = new mongoose.Types.ObjectId();
  const stranger = new mongoose.Types.ObjectId();

  assert.equal(access.resolveClassGroupId({ classGroup: gid }), String(gid));
  assert.equal(access.resolveClassGroupId({ classGroup: { _id: gid, code: "SM-MATH-JHS1-1" } }), String(gid));
  assert.equal(access.resolveClassGroupId({ classGroup: null }), null);
  assert.equal(access.resolveNotificationClassGroupId({ classGroupId: gid }), String(gid));
  assert.equal(access.resolveNotificationClassGroupId({}), null);

  const rows = [{ _id: 1, classGroup: gid }, { _id: 2, classGroup: stranger }, { _id: 3 }];
  assert.equal(access.filterSessionsForAssignedGroups(rows, [gid]).length, 1, "only the assigned group's row survives");
  assert.deepEqual(access.filterSessionsForAssignedGroups(rows, []), [], "no assignment -> nothing is visible");

  assert.equal(access.isNotificationVisibleToStudent({ classGroupId: null }, []), true, "school-wide notice");
  assert.equal(access.isNotificationVisibleToStudent({ classGroupId: gid }, []), false, "group notice without an assignment");
  assert.equal(access.isNotificationVisibleToStudent({ classGroupId: String(gid) }, [gid]), true);

  // Id normalisation: routes pass strings, services pass ObjectId instances.
  assert.equal(access.toIdString(gid), String(gid));
  assert.equal(access.toIdString(String(gid).toUpperCase()), String(gid), "uppercase hex normalises to canonical form");
  assert.equal(access.toIdString("not-an-id"), null);
  assert.equal(access.toIdString(""), null);
  assert.equal(access.toIdString(null), null);
});

