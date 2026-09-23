// scripts/seed-real-classes.js
//
// Seeds REAL, end-to-end class data for testing the Google Meet co-host
// workflow. Unlike the old dev dummy seeder, this script:
//
//   * creates a class group with a production-shaped code
//   * creates ClassSessions and calls the SAME createMeeting() service the
//     Tutor Manager scheduling flow uses, so every session gets a genuine
//     Google Calendar event + Google Meet link owned by
//     virtualclass@studiesmasters.com
//   * records googleMeet.ownerEmail / googleMeet.teacherEmail and the correct
//     coHostStatus (invited when the teacher has a verified Google account,
//     not_configured otherwise)
//   * pushes every session into Moodle through syncClassSession() so the Meet
//     link is reachable from the student's Moodle calendar
//   * notifies the student and the teacher with real notification text
//
// Usage (from Studiesmasters-backend):
//   npm run seed:real-classes -- --student-email=a@b.com --teacher-email=t@b.com
//   npm run seed:real-classes -- --student-id=<mongoId> --teacher-id=<mongoId>
//   npm run seed:real-classes -- --cleanup     (remove seeded rows)
//
// Options: --sessions=3 --subject=Mathematics --grade="JHS 2" --cleanup
import dotenv from "dotenv";
import mongoose from "mongoose";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";
import { notifyStudent, notifyTeacher } from "../services/qao/notification.service.js";

dotenv.config();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(=(.*))?$/);
    return m ? [m[1], m[3] ?? "true"] : [a, "true"];
  })
);

const MONGO_URI =
  process.env.MONGO_URI ||
  (process.env.MONGO_USER && process.env.MONGO_HOST
    ? "mongodb+srv://" + encodeURIComponent(process.env.MONGO_USER) + ":" + encodeURIComponent(process.env.MONGO_PASSWORD || "") + "@" + process.env.MONGO_HOST + "/" + encodeURIComponent(process.env.MONGO_DB_NAME || "test")
    : null);

if (!MONGO_URI) {
  console.error("MONGO_URI (or MONGO_USER/MONGO_HOST/...) is not defined. Add it to your .env file.");
  process.exit(1);
}

const cleanupRequested = args.cleanup === "true";
const skipNotifications = args["skip-notifications"] === "true";
const skipMoodle = args["skip-moodle"] === "true";
const subject = args.subject || "Mathematics";
const grade = args.grade || "JHS 2";
const sessionCount = Math.max(1, Number(args.sessions) || 3);

// Seeded rows are tagged with this group-code prefix so they can be removed
// without touching real academic data.
const SEED_CODE_PREFIX = "SM-TEST-";
const LEGACY_CODE_PREFIX = /^(DUMMY|DEMO)-/;
const OWNER_EMAIL = process.env.GOOGLE_MEET_OWNER_EMAIL || "virtualclass@studiesmasters.com";

async function findStudent() {
  if (args["student-id"]) return Student.findById(args["student-id"]);
  if (args["student-email"]) return Student.findOne({ email: String(args["student-email"]).toLowerCase() });
  return Student.findOne().sort({ createdAt: -1 });
}

async function findTeacher() {
  if (args["teacher-id"]) return Teacher.findById(args["teacher-id"]);
  if (args["teacher-email"]) return Teacher.findOne({ email: String(args["teacher-email"]).toLowerCase() });
  return Teacher.findOne().sort({ createdAt: -1 });
}

function nextDate(offsetDays, hour) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, 0, 0, 0);
  return d;
}


/** Create one session with a REAL Google Meet link (same path as scheduling). */
async function createSessionWithMeeting({ group, teacher, date, startTime, endTime, index }) {
  const { createMeeting } = await import("../services/google/meet.service.js");

  const teacherGoogleEmail = teacher?.googleAccountVerified ? teacher.googleMeetEmail : null;

  const meeting = await createMeeting({
    subject: group.subject,
    grade: group.grade,
    teacherName: teacher?.fullName || teacher?.name || "",
    teacherEmail: teacherGoogleEmail || null,
    date,
    startTime,
    endTime,
    sessionId: null,
    rollNumber: group.code,
  });

  const coHostStatus = teacher?.googleAccountVerified && teacherGoogleEmail
    ? "invited"
    : teacher?.googleAccountVerified
      ? "teacher_verified"
      : "not_configured";

  const session = new ClassSession({
    classGroup: group._id,
    teacher: teacher?._id || group.teacher || null,
    date,
    startTime,
    endTime,
    status: "scheduled",
    meetingProvider: meeting.meetingProvider,
    meetingLink: meeting.meetingLink || "",
    meetingCode: meeting.meetingCode || "",
    conferenceId: meeting.conferenceId || "",
    calendarEventId: meeting.calendarEventId || "",
    meetingStatus: meeting.meetingLink ? "ready" : "pending",
    meetingOwner: OWNER_EMAIL,
    coHostStatus,
    googleMeet: {
      ownerEmail: OWNER_EMAIL,
      teacherEmail: teacherGoogleEmail || "",
      meetingLink: meeting.meetingLink || "",
      meetingCode: meeting.meetingCode || "",
      conferenceId: meeting.conferenceId || "",
      calendarEventId: meeting.calendarEventId || "",
    },
    notes: `Seeded test session ${index + 1} of ${sessionCount}`,
  });
  await session.save();

  // Push to Moodle so students find the class (and its Meet link) in Moodle.
  if (!skipMoodle) {
    try {
      const { syncClassSession, CLASS_SYNC_ACTIONS } = await import("../services/moodle/syncClass.js");
      await syncClassSession(session.toObject(), {
        action: session.meetingStatus === "ready" ? CLASS_SYNC_ACTIONS.MEETING_READY : CLASS_SYNC_ACTIONS.CREATED,
        sessionId: session._id,
      });
    } catch (err) {
      console.log("  (moodle sync skipped)", String(err?.message || err).slice(0, 120));
    }
  }

  return session;
}

async function seedRealClasses(student, teacher) {
  const code = `${SEED_CODE_PREFIX}${Date.now().toString(36).toUpperCase()}`;
  const group = await ClassGroup.create({
    code,
    curriculum: student?.curriculum || teacher?.curriculum || "GES",
    grade,
    subject,
    capacity: 5,
    teacher: teacher?._id || null,
    students: student ? [student._id] : [],
    status: "active",
    weeklySlots: [
      { day: "Monday", startTime: "15:00", endTime: "16:00" },
      { day: "Wednesday", startTime: "15:00", endTime: "16:00" },
      { day: "Friday", startTime: "15:00", endTime: "16:00" },
    ],
  });
  console.log(`ClassGroup ${group.code} · ${subject} · ${grade}`);
  console.log(`  Student    : ${student?.fullName || "-"} <${student?.email || "-"}>`);
  console.log(`  Teacher    : ${teacher?.fullName || teacher?.name || "-"} <${teacher?.email || "-"}>`);
  console.log(`  Meet owner : ${OWNER_EMAIL}`);
  console.log(`  Teacher Google: ${teacher?.googleAccountVerified ? `${teacher.googleMeetEmail} (verified)` : "not connected"}`);

  const slots = [
    { offset: 1, hour: 15 },
    { offset: 3, hour: 15 },
    { offset: 5, hour: 15 },
  ].slice(0, sessionCount);

  const created = [];
  for (const [i, s] of slots.entries()) {
    const start = nextDate(s.offset, s.hour);
    const end = nextDate(s.offset, s.hour + 1);
    const pad = (n) => String(n).padStart(2, "0");
    const session = await createSessionWithMeeting({
      group,
      teacher,
      date: start,
      startTime: `${pad(start.getHours())}:00`,
      endTime: `${pad(end.getHours())}:00`,
      index: i,
    });
    created.push(session);
    console.log(
      `  session ${i + 1}: ${start.toLocaleDateString()} ${session.startTime}-${session.endTime} · ` +
        `${session.meetingStatus} · ${session.meetingLink || "no meet link"} · coHost=${session.coHostStatus}`
    );
  }
  return { group, sessions: created };
}

async function cleanupSeeded() {
  const groups = await ClassGroup.find({
    $or: [{ code: new RegExp(`^${SEED_CODE_PREFIX}`) }, { code: LEGACY_CODE_PREFIX }],
  }).select("_id code").lean();
  const groupIds = groups.map((g) => g._id);
  const sessions = groupIds.length
    ? await ClassSession.deleteMany({ classGroup: { $in: groupIds } })
    : { deletedCount: 0 };
  const groupsRes = await ClassGroup.deleteMany({ _id: { $in: groupIds } });
  console.log("Cleanup done:", groupsRes.deletedCount || 0, "group(s),", sessions.deletedCount || 0, "session(s) removed.");
}

await mongoose.connect(MONGO_URI);
try {
  if (cleanupRequested) {
    await cleanupSeeded();
  } else {
    const student = await findStudent();
    const teacher = await findTeacher();
    if (!student && !teacher) throw new Error("No student or teacher found. Pass --student-email / --teacher-email explicitly.");

    const { group } = await seedRealClasses(student, teacher);

    if (!skipNotifications) {
      const stamp = new Date().toLocaleString();
      if (student) {
        await notifyStudent({
          studentId: student._id,
          type: "info",
          title: "New Class Added to Your Timetable",
          message: `${subject} (${grade}) with ${teacher?.fullName || teacher?.name || "your tutor"} — ${sessionCount} session(s) this week. Added ${stamp}.`,
        }).catch(() => {});
      }
      if (teacher) {
        await notifyTeacher({
          teacherId: teacher._id,
          type: "info",
          title: "New Class Scheduled",
          message: `${subject} (${grade}) — ${sessionCount} session(s) this week. Google Meet links are ready in your timetable and Moodle. Added ${stamp}.`,
        }).catch(() => {});
      }
    }

    console.log("\nDone. Verify in the teacher + student dashboards, and in Moodle:");
    console.log("  - ClassSession.googleMeet.ownerEmail =", OWNER_EMAIL);
    console.log("  - ClassSession.googleMeet.teacherEmail =", teacher?.googleMeetEmail || "(teacher Google not connected)");
    console.log("  Group code:", group.code);
  }
} catch (err) {
  console.error("Real class seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

