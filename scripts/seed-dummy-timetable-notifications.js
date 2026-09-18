// scripts/seed-dummy-timetable-notifications.js
// Dev-only helper: seeds DUMMY timetable notifications AND a visible dummy
// calendar (ClassGroup DUMMY-xxx + ClassSessions) for one student + teacher.
//
// Usage (from Studiesmasters-backend):
//   npm run seed:dummy-timetable -- --student-email=a@b.com --teacher-email=t@b.com
//   npm run seed:dummy-timetable -- --student-id=<mongoId> --teacher-id=<mongoId>
//   npm run seed:dummy-timetable -- --calendar-only      (classes only)
//   npm run seed:dummy-timetable -- --emit-only          (socket pings only)
//   npm run seed:dummy-timetable -- --cleanup            (delete all dummy rows)
import dotenv from "dotenv";
import mongoose from "mongoose";
import Student from "../models/Student.js";
import Teacher from "../models/teacher.js";
import ClassGroup from "../models/ClassGroup.js";
import ClassSession from "../models/ClassSession.js";
import Notification from "../models/Notification.js";
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

const emitOnly = args["emit-only"] === "true";
const cleanupRequested = args.cleanup === "true";
const skipNotifications = args["calendar-only"] === "true" || args["skip-notifications"] === "true";
const skipCalendar = args["no-calendar"] === "true" || args["skip-calendar"] === "true";
const stamp = new Date().toLocaleString();
const tag = "[DUMMY]";

const studentDummies = [
  { title: tag + " Timetable published", type: "info", message: "Dummy timetable for GES Grade 10 (Mathematics, English, Science) is ready. Week of Mon-Fri, 8:00-12:00. Seeded " + stamp + "." },
  { title: tag + " New Class Added to Your Timetable", type: "info", message: "Dummy class: Mathematics with your tutor, tomorrow 9:00-10:00 (GES Grade 10). Seeded " + stamp + "." },
];
const teacherDummies = [
  { title: tag + " Timetable published", type: "info", message: "Your dummy GES Grade 10 timetable (Mathematics) is live. 3 classes this week. Seeded " + stamp + "." },
  { title: tag + " New Class Scheduled", type: "info", message: "Dummy class: Mathematics, GES Grade 10, tomorrow 9:00-10:00. Seeded " + stamp + "." },
];

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

function nextDate(offsetDays, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// One DUMMY- class group + 3 sessions (1 live today, 2 upcoming) enrolling the
// student and assigning the teacher, so both dashboards render a calendar.
async function seedDummyCalendar(student, teacher) {
  const code = "DUMMY-" + Date.now().toString(36).toUpperCase();
  const group = await ClassGroup.create({
    code,
    curriculum: student?.curriculum || teacher?.curriculum || "GES",
    grade: student?.grade || "10",
    subject: "Mathematics",
    capacity: 5,
    teacher: teacher?._id || null,
    students: student ? [student._id] : [],
    status: "active",
    weeklySlots: [
      { day: "Monday", startTime: "09:00", endTime: "10:00" },
      { day: "Wednesday", startTime: "09:00", endTime: "10:00" },
      { day: "Friday", startTime: "09:00", endTime: "10:00" },
    ],
  });
  console.log("ClassGroup:", group.code, "(Mathematics) student:", student?.fullName || "-", "teacher:", teacher?.fullName || teacher?.name || "-");
  const slots = [
    { offset: 0, hour: 10, status: "live" },
    { offset: 1, hour: 9, status: "scheduled" },
    { offset: 3, hour: 9, status: "scheduled" },
  ];
  for (const [i, s] of slots.entries()) {
    const start = nextDate(s.offset, s.hour, 0);
    const end = nextDate(s.offset, s.hour + 1, 0);
    const session = new ClassSession({
      classGroup: group._id,
      teacher: teacher?._id || group.teacher,
      date: start,
      startTime: String(start.getHours()).padStart(2, "0") + ":00",
      endTime: String(end.getHours()).padStart(2, "0") + ":00",
      status: s.status,
      meetingLink: "https://meet.google.com/dummy-test-class",
      meetingStatus: "ready",
      notes: "[DUMMY] seeded test session " + (i + 1),
    });
    await session.save();
    console.log("  session", i + 1, ":", s.status, start.toLocaleString(), "->", session._id);
  }
  return group;
}

async function cleanupDummies() {
  const groups = await ClassGroup.find({ code: /^DUMMY-/ }).select("_id").lean();
  const groupIds = groups.map((g) => g._id);
  const sessions = groupIds.length ? await ClassSession.deleteMany({ classGroup: { $in: groupIds } }) : { deletedCount: 0 };
  const groupsRes = await ClassGroup.deleteMany({ code: /^DUMMY-/ });
  const notifs = await Notification.deleteMany({ title: /^\[DUMMY\]/ });
  console.log("Cleanup done:", groupsRes.deletedCount || 0, "group(s),", sessions.deletedCount || 0, "session(s),", notifs.deletedCount || 0, "notification(s) removed.");
}

await mongoose.connect(MONGO_URI);
try {
  if (cleanupRequested) {
    await cleanupDummies();
  } else {
    const student = await findStudent();
    const teacher = await findTeacher();
    if (!student && !teacher) throw new Error("No student or teacher found. Pass --student-email / --teacher-email explicitly.");

    if (!skipNotifications && student) {
      console.log("Student:", student.fullName, "<" + student.email + ">", "(" + student._id + ")");
      for (const d of studentDummies) {
        if (emitOnly) {
          const { emitToStudent } = await import("../services/qao/notify.js");
          emitToStudent(String(student._id), "notification:new", { ...d });
          console.log("  (emit-only) socket -> student:" + student._id, "::", d.title);
        } else {
          const n = await notifyStudent({ studentId: student._id, ...d });
          console.log("  created", n._id, "::", d.title);
        }
      }
    } else if (!skipNotifications) console.log("No student targeted (pass --student-email=... to include one).");

    if (!skipNotifications && teacher) {
      console.log("Teacher:", teacher.fullName || teacher.name, "<" + teacher.email + ">", "(" + teacher._id + ")");
      for (const d of teacherDummies) {
        if (emitOnly) {
          const { emitToTeacher } = await import("../services/qao/notify.js");
          emitToTeacher(String(teacher._id), "notification:new", { ...d });
          console.log("  (emit-only) socket -> teacher:" + teacher._id, "::", d.title);
        } else {
          const n = await notifyTeacher({ teacherId: teacher._id, ...d });
          console.log("  created", n._id, "::", d.title);
        }
      }
    } else if (!skipNotifications) console.log("No teacher targeted (pass --teacher-email=... to include one).");

    if (!emitOnly && !skipCalendar && (student || teacher)) {
      await seedDummyCalendar(student, teacher);
    } else if (emitOnly) {
      console.log("(emit-only) calendar skipped - re-run without --emit-only to seed dummy classes.");
    }
    console.log("\nDone. Open the student + teacher dashboards: the bell shows the [DUMMY] rows and the Overview tab shows the dummy calendar.");
  }
} catch (err) {
  console.error("Dummy timetable seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
