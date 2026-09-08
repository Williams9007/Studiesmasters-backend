import LeaveRequest from "../../models/LeaveRequest.js";
import { TEACHER_SAFE_PROJECTION, sanitizeTeacher } from "./sanitize.js";
import { emitToQaos, emitToTeacher } from "./notify.js";
import { findAffectedSessions } from "./leaveImpact.service.js";
import { logQaoAction } from "./audit.service.js";
import { createNotification, notifyAllQaos } from "./notification.service.js";

const SAFE_REVIEWER_FIELDS = "name email";

function validateDates(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start) || isNaN(end)) throw new Error("startDate and endDate must be valid dates");
  if (end < start) throw new Error("endDate must be on or after startDate");
  return { start, end };
}

export async function listRequests({ status, teacherId } = {}) {
  const query = {};
  if (status) query.status = status;
  if (teacherId) query.teacher = teacherId;
  return LeaveRequest.find(query)
    .populate("teacher", TEACHER_SAFE_PROJECTION)
    .populate("reviewedBy", SAFE_REVIEWER_FIELDS)
    .sort({ createdAt: -1 })
    .lean();
}

export async function getRequest(id) {
  const request = await LeaveRequest.findById(id)
    .populate("teacher", TEACHER_SAFE_PROJECTION)
    .populate("reviewedBy", SAFE_REVIEWER_FIELDS)
    .lean();
  if (!request) throw new Error("Leave request not found");
  return request;
}

export async function submitRequest({ teacherId, leaveType, startDate, endDate, reason, submittedBy }) {
  if (!teacherId) throw new Error("teacherId is required");
  if (!["sick", "vacation", "personal", "emergency", "other"].includes(leaveType)) {
    throw new Error("Invalid leave type");
  }
  const { start, end } = validateDates(startDate, endDate);
  // Prevent an overlapping pending/approved leave for the same teacher
  const overlap = await LeaveRequest.findOne({
    teacher: teacherId,
    status: { $in: ["pending", "approved"] },
    startDate: { $lte: end },
    endDate: { $gte: start },
  })
    .select("_id")
    .lean();
  if (overlap) throw new Error("This teacher already has a pending or approved leave overlapping these dates");

  const request = await LeaveRequest.create({
    teacher: teacherId,
    leaveType,
    startDate: start,
    endDate: end,
    reason: reason || "",
    submittedBy: submittedBy === "qao" ? "qao" : "teacher",
  });
  emitToQaos("leave:request:new", {
    requestId: request._id,
    teacherId,
    leaveType,
    startDate: request.startDate,
    endDate: request.endDate,
  });
  return getRequest(request._id);
}

// QAO review. On approval, affected sessions are computed and
// session:needs-substitute is emitted for each one (no auto-assignment).
export async function reviewRequest(id, { status, reviewNote }, reviewerId) {
  if (!["approved", "rejected"].includes(status)) {
    throw new Error("status must be approved or rejected");
  }
  const request = await LeaveRequest.findById(id);
  if (!request) throw new Error("Leave request not found");
  if (request.status !== "pending") throw new Error("Only pending requests can be reviewed");

  request.status = status;
  request.reviewNote = reviewNote || "";
  request.reviewedBy = reviewerId;
  request.reviewedAt = new Date();
  await request.save();

  emitToQaos(status === "approved" ? "leave:approved" : "leave:rejected", { requestId: request._id, teacherId: request.teacher });
  emitToTeacher(request.teacher, status === "approved" ? "leave:approved" : "leave:rejected", {
    requestId: request._id,
    status,
    reviewNote: request.reviewNote,
  });
  await logQaoAction({
    action: status === "approved" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
    resource: "LeaveRequest",
    resourceId: request._id,
    details: { teacherId: String(request.teacher), leaveType: request.leaveType, startDate: request.startDate, endDate: request.endDate, reviewNote: request.reviewNote },
  });
  await logQaoAction({
    action: status === "approved" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
    resource: "LeaveRequest",
    resourceId: request._id,
    details: { teacherId: String(request.teacher), leaveType: request.leaveType, startDate: request.startDate, endDate: request.endDate, reviewNote: request.reviewNote },
  });
  await logQaoAction({
    action: status === "approved" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
    resource: "LeaveRequest",
    resourceId: request._id,
    details: { teacherId: String(request.teacher), leaveType: request.leaveType, startDate: request.startDate, endDate: request.endDate, reviewNote: request.reviewNote },
  });

  let impact = null;
  if (status === "approved") {
    impact = await findAffectedSessions(request);
    for (const session of impact.affectedSessions) {
      emitToQaos("session:needs-substitute", {
        sessionId: session._id,
        classGroup: session.classGroup?.code,
        date: session.date,
        suggestions: (session.suggestedSubstitutes || []).slice(0, 3),
      });
    }
  }
  return { leave: await getRequest(id), impact };
}

// Teacher cancels their own pending request (also used by QAO delete checks)
export async function cancelRequest(id, teacherId) {
  const request = await LeaveRequest.findById(id);
  if (!request) throw new Error("Leave request not found");
  if (String(request.teacher) !== String(teacherId)) throw new Error("You can only cancel your own leave requests");
  if (request.status !== "pending") throw new Error("Only pending requests can be cancelled");
  request.status = "cancelled";
  await request.save();
  emitToQaos("leave:cancelled", { requestId: request._id, teacherId });
  return getRequest(id);
}

export async function deleteRequest(id) {
  const request = await LeaveRequest.findById(id);
  if (!request) throw new Error("Leave request not found");
  if (request.status === "approved") throw new Error("Approved leave cannot be deleted; reject or cancel it instead");
  await request.deleteOne();
  return { ok: true };
}

// Leave report: totals by status + approved leave days
export async function leaveReport() {
  const requests = await LeaveRequest.find({})
    .populate("teacher", "fullName")
    .lean();
  const byStatus = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
  let approvedDays = 0;
  const perTeacher = new Map();
  for (const r of requests) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.status === "approved") {
      const days = Math.max(1, Math.ceil((new Date(r.endDate) - new Date(r.startDate)) / 86400000) + 1);
      approvedDays += days;
      const key = String(r.teacher?._id || r.teacher);
      const entry = perTeacher.get(key) || { teacherId: r.teacher?._id || r.teacher, name: r.teacher?.fullName || "Teacher", days: 0, requests: 0 };
      entry.days += days;
      entry.requests += 1;
      perTeacher.set(key, entry);
    }
  }
  return {
    totals: { ...byStatus, approvedDays, total: requests.length },
    approvedByTeacher: [...perTeacher.values()].sort((a, b) => b.days - a.days),
  };
}
