import AuditLog from "../../models/AuditLog.js";

// Operational audit service. QAO-sensitive actions write an audit record with a
// generic actor (QaoUser) while keeping the existing admin flow untouched.
// No student PII is ever stored in `details`.

function ipFromReq(req) {
  return req?.ip || req?.connection?.remoteAddress || null;
}
function uaFromReq(req) {
  return req?.headers?.["user-agent"] || null;
}

export async function logQaoAction({
  actor,
  action,
  resource,
  resourceId,
  details = null,
  req = null,
  success = true,
}) {
  try {
    await AuditLog.create({
      actor: actor?.id || actor?._id || null,
      actorRole: "qao",
      actorEmail: actor?.email || null,
      action,
      resource,
      resourceId: resourceId ? String(resourceId) : null,
      details,
      ip: ipFromReq(req),
      userAgent: uaFromReq(req),
      success,
      method: req?.method || null,
      path: req?.originalUrl || req?.path || null,
    });
  } catch (err) {
    console.error("QAO audit log error:", err.message);
  }
  return null;
}

// Fetch QAO-originated audit records (actorRole = qao), newest first.
export async function listQaoAuditLogs({ limit = 100, offset = 0, action } = {}) {
  const query = { actorRole: { $in: ["qao", "admin"] } };
  if (action) query.action = action;
  const [logs, total] = await Promise.all([
    AuditLog.find(query)
      .sort({ createdAt: -1 })
      .skip(Number(offset) || 0)
      .limit(Math.min(Number(limit) || 100, 500))
      .lean(),
    AuditLog.countDocuments(query),
  ]);
  return { logs, total };
}