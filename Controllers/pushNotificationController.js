// controllers/pushNotificationController.js
// Handles Web Push API subscriptions and sending push notifications
// to browsers even when the user is logged out or not actively using the app.
import webpush from "web-push";
// Resolve from this file's URL at runtime so TypeScript does not create a
// second program entry when the project directory differs only by casing.
const { default: PushSubscription } = await import(
  new URL("../models/PushSubscription.js", import.meta.url).href
);

// ---------------------------------------------------------------------------
// VAPID keys — generate at startup if not provided in env.
// In production, set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in your .env.
// ---------------------------------------------------------------------------
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const generated = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = generated.publicKey;
  process.env.VAPID_PRIVATE_KEY = generated.privateKey;
  console.warn("⚠️  VAPID keys not found in env — generated ephemeral keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env for production.");
}

webpush.setVapidDetails(
  "mailto:info@studiesmasters.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ---------------------------------------------------------------------------
// In-memory subscription store (replace with DB in production).
// Each subscription is a PushSubscription object from the browser.
// ---------------------------------------------------------------------------
const subscriptions = new Set();

const buildPushPayload = (title, body, url = "/", extra = {}) => JSON.stringify({
  type: extra.type || "info",
  title,
  body,
  message: extra.message || body,
  url: extra.url || url || "/",
  icon: extra.icon || "/favicon.png",
  badge: extra.badge || "/favicon.png",
  tag: extra.tag || `studiesmasters-${extra.type || "notification"}`,
  requireInteraction: Boolean(extra.requireInteraction),
  silent: Boolean(extra.silent),
  createdAt: extra.createdAt || new Date().toISOString(),
});

/**
 * GET /api/notifications/vapidPublicKey
 * Returns the public VAPID key so the frontend can subscribe.
 */
export const getVapidPublicKey = (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
};

/**
 * POST /api/notifications/subscribe
 * Saves a push subscription.
 * Body: { endpoint, keys: { p256dh, auth }, userId?, role? }
 * The optional userId/role link the browser subscription to a timetable
 * recipient so createSession()/publishTimetable() can target the right
 * teacher + students instead of broadcasting to everyone.
 */
export const subscribe = async (req, res) => {
  const subscription = req.body?.subscription || req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, message: "Invalid subscription" });
  }

  const userId = req.body?.userId || subscription.userId || null;
  const role = req.body?.role || subscription.role || null;

  // 1) durable store (survives restarts) — upsert by endpoint
  try {
    await PushSubscription.updateOne(
      { endpoint: subscription.endpoint },
      {
        $set: {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.keys?.p256dh || "",
            auth: subscription.keys?.auth || "",
          },
          userAgent: req.headers["user-agent"] || "",
          ...(userId ? { userId } : {}),
          ...(role ? { role } : {}),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("Push subscription DB save failed (using memory only):", err.message);
  }

  // 2) in-memory store (current process) — dedupe by endpoint
  const existing = Array.from(subscriptions).find(
    (s) => s.endpoint === subscription.endpoint
  );
  if (existing) subscriptions.delete(existing);
  subscriptions.add({
    endpoint: subscription.endpoint,
    keys: subscription.keys || {},
    userId: userId ? String(userId) : null,
    role: role || null,
  });

  console.log(`🔔 Push subscription saved. Total: ${subscriptions.size}`);
  res.status(201).json({ success: true, message: "Subscribed to push notifications" });
};

/**
 * DELETE /api/notifications/unsubscribe
 * Removes a push subscription (user opted out) from BOTH stores.
 */
export const unsubscribe = async (req, res) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ success: false, message: "Endpoint required" });
  }

  let found = false;
  for (const sub of subscriptions) {
    if (sub.endpoint === endpoint) {
      subscriptions.delete(sub);
      found = true;
      break;
    }
  }

  try {
    const r = await PushSubscription.deleteOne({ endpoint });
    if ((r?.deletedCount || 0) > 0) found = true;
  } catch { /* memory cleanup above is enough */ }

  if (found) {
    console.log(`🔕 Push subscription removed. Total: ${subscriptions.size}`);
    res.json({ success: true, message: "Unsubscribed from push notifications" });
  } else {
    res.status(404).json({ success: false, message: "Subscription not found" });
  }
};

/**
 * POST /api/notifications/send
 * Sends a push notification to ALL subscribed browsers.
 * Body: { title: "Notification title", body: "Message body", url?: "/path" }
 * This works even if the user is logged out — the browser receives the
 * push via the service worker.
 */
export const sendNotification = async (req, res) => {
  const { title, body, message, url, type, icon, badge, tag, requireInteraction, silent } = req.body;
  const pushBody = body || message;

  if (!title || !pushBody) {
    return res.status(400).json({ success: false, message: "Title and body are required" });
  }

  const payload = buildPushPayload(title, pushBody, url || "/", {
    type,
    icon,
    badge,
    tag,
    requireInteraction,
    silent,
  });

  const results = [];
  const deadEndpoints = [];

  // 1) durable subscriptions (survive restarts)
  let dbSubs = [];
  try {
    dbSubs = await PushSubscription.find({}).lean();
  } catch {
    dbSubs = [];
  }

  // 2) ephemeral in-memory subscriptions (current process)
  const allTargets = [
    ...dbSubs.map((s) => ({ endpoint: s.endpoint, keys: s.keys || {}, _db: true })),
    ...Array.from(subscriptions).map((s) => ({
      endpoint: s?.endpoint,
      keys: s?.keys || {},
      _db: false,
    })),
  ].filter((s) => s.endpoint);

  // De-dupe by endpoint (a browser may exist in both stores).
  const seen = new Set();
  const unique = allTargets.filter((s) => {
    if (seen.has(s.endpoint)) return false;
    seen.add(s.endpoint);
    return true;
  });

  for (const target of unique) {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        payload
      );
      results.push({ endpoint: target.endpoint, status: "sent" });
    } catch (err) {
      // 410 Gone — subscription is no longer valid (user unsubscribed or browser cleared)
      if (err.statusCode === 410 || err.statusCode === 404) {
        deadEndpoints.push(target.endpoint);
        subscriptions.forEach((s) => {
          if (s?.endpoint === target.endpoint) subscriptions.delete(s);
        });
        if (target._db) {
          try {
            await PushSubscription.deleteOne({ endpoint: target.endpoint });
          } catch { /* best-effort cleanup */ }
        }
      }
      results.push({ endpoint: target.endpoint, status: "error", error: err.message });
    }
  }

  // Clean up dead subscriptions
  if (deadEndpoints.length) {
    console.log(`🧹 Cleaned up ${deadEndpoints.length} dead subscriptions`);
  }

  res.json({
    success: true,
    sent: results.filter((r) => r.status === "sent").length,
    errors: results.filter((r) => r.status === "error").length,
    totalSubscriptions: subscriptions.size,
  });
};

/**
 * GET /api/notifications/count
 * Returns the number of active subscriptions.
 */
export const getSubscriptionCount = (req, res) => {
  res.json({ count: subscriptions.size });
};

/**
 * Send a push notification to a subset of subscriptions (filtered in-memory).
 * Used internally by targeted timetable helpers below.
 */
const sendPushFiltered = async (filterFn, title, body, url = "/", options = {}) => {
  if (!title || !body) {
    throw new Error("Title and body are required");
  }

  const payload = buildPushPayload(title, body, url, options);

  // 1) durable subscriptions (survive restarts)
  let dbSubs = [];
  try {
    dbSubs = await PushSubscription.find({}).lean();
  } catch {
    dbSubs = [];
  }

  // 2) ephemeral in-memory subscriptions (current process)
  const memSubs = Array.from(subscriptions);

  const targets = [
    ...dbSubs.map((s) => ({
      endpoint: s.endpoint,
      keys: s.keys || {},
      userId: s.userId ? String(s.userId) : null,
      role: s.role || null,
      _dbId: s._id,
      _db: true,
    })),
    ...memSubs.map((s) => ({
      endpoint: s?.endpoint,
      keys: s?.keys || {},
      userId: s?.userId ? String(s.userId) : (s?.user?.userId ? String(s.user.userId) : null),
      role: s?.role || s?.user?.role || null,
      _db: false,
    })),
  ].filter((s) => s.endpoint && filterFn(s));

  // De-dupe by endpoint (a browser may exist in both stores).
  const seen = new Set();
  const unique = targets.filter((s) => {
    if (seen.has(s.endpoint)) return false;
    seen.add(s.endpoint);
    return true;
  });

  const results = [];
  for (const target of unique) {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        payload
      );
      results.push({ endpoint: target.endpoint, status: "sent" });
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        subscriptions.forEach((s) => {
          if (s?.endpoint === target.endpoint) subscriptions.delete(s);
        });
        if (target._db) {
          try {
            await PushSubscription.deleteOne({ endpoint: target.endpoint });
          } catch { /* best-effort cleanup */ }
        }
      }
      results.push({ endpoint: target.endpoint, status: "error", error: err.message });
    }
  }

  return {
    sent: results.filter((r) => r.status === "sent").length,
    errors: results.filter((r) => r.status === "error").length,
    totalSubscriptions: unique.length,
  };
};

/**
 * Send a timetable push to ONE teacher (all of their subscribed devices).
 * Timetable flow: createSession() in services/qao/scheduling.service.js.
 */
export const sendPushToTeacher = async (teacherId, title, body, url = "/dashboard", options = {}) => {
  if (!teacherId) return { sent: 0, errors: 0, totalSubscriptions: 0 };
  const id = String(teacherId?._id || teacherId);
  return sendPushFiltered((s) => s.userId === id || s.role === "teacher", title, body, url, {
    type: "teacher",
    ...options,
  });
};

/**
 * Send a timetable push to the enrolled students of a class.
 * Timetable flow: createSession() in services/qao/scheduling.service.js.
 */
export const sendPushToStudents = async (studentIds, title, body, url = "/dashboard", options = {}) => {
  const ids = new Set((Array.isArray(studentIds) ? studentIds : []).map((id) => String(id?._id || id)));
  if (!ids.size) return { sent: 0, errors: 0, totalSubscriptions: 0 };
  return sendPushFiltered(
    (s) => (s.userId && ids.has(s.userId)) || s.role === "student",
    title,
    body,
    url,
    { type: "student", ...options }
  );
};

/**
 * Send a timetable push to every subscribed Tutor Manager (QAO).
 * Timetable flow: teacher timetable submission in routes/teacherRoutes.js.
 */
export const sendPushToQaos = async (title, body, url = "/qao/dashboard", options = {}) =>
  sendPushFiltered((s) => s.role === "qao", title, body, url, { type: "qao", ...options });

export const sendPushToUsers = async (userIds, title, body, url = "/", options = {}) => {
  const ids = new Set((Array.isArray(userIds) ? userIds : []).map((id) => String(id?._id || id)));
  if (!ids.size) return { sent: 0, errors: 0, totalSubscriptions: 0 };
  return sendPushFiltered((s) => s.userId && ids.has(s.userId), title, body, url, options);
};

export const sendPushToRole = async (role, title, body, url = "/", options = {}) => {
  if (!role) return { sent: 0, errors: 0, totalSubscriptions: 0 };
  return sendPushFiltered((s) => s.role === role, title, body, url, { type: role, ...options });
};
/**
 * Send a push notification to ALL subscribed browsers.
 * Reusable programmatically (e.g. by the System Guard alert service).
 * Timetable batch flow: publishTimetable() in services/timetable.service.js
 * sends ONE summary push per published schedule via this helper.
 * Returns { sent, errors, totalSubscriptions }.
 */
export const sendPushToAll = async (title, body, url = "/", options = {}) => {
  if (!title || !body) {
    throw new Error("Title and body are required");
  }

  // Broadcast = no recipient filter, but it still reads the durable store,
  // de-dupes by endpoint and prunes dead (410/404) subscriptions exactly like
  // the targeted helpers do. (Previously this duplicated that loop and read an
  // out-of-scope `unique` variable, which threw a ReferenceError.)
  return sendPushFiltered(() => true, title, body, url, options);
};
