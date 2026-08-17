// controllers/pushNotificationController.js
// Handles Web Push API subscriptions and sending push notifications
// to browsers even when the user is logged out or not actively using the app.
import webpush from "web-push";

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

/**
 * GET /api/notifications/vapidPublicKey
 * Returns the public VAPID key so the frontend can subscribe.
 */
export const getVapidPublicKey = (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
};

/**
 * POST /api/notifications/subscribe
 * Saves a push subscription. No auth required — works even when logged out.
 * The subscription includes an endpoint URL that uniquely identifies the
 * browser/device, so the same user on multiple devices gets multiple entries.
 */
export const subscribe = (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, message: "Invalid subscription" });
  }

  // Store the subscription (dedupe by endpoint)
  const existing = Array.from(subscriptions).find(
    (s) => s.endpoint === subscription.endpoint
  );
  if (!existing) {
    subscriptions.add(subscription);
  }

  console.log(`🔔 Push subscription saved. Total: ${subscriptions.size}`);
  res.status(201).json({ success: true, message: "Subscribed to push notifications" });
};

/**
 * DELETE /api/notifications/unsubscribe
 * Removes a push subscription (user opted out).
 */
export const unsubscribe = (req, res) => {
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
  const { title, body, url } = req.body;

  if (!title || !body) {
    return res.status(400).json({ success: false, message: "Title and body are required" });
  }

  const payload = JSON.stringify({ title, body, url: url || "/" });

  const results = [];
  const deadEndpoints = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      results.push({ endpoint: sub.endpoint, status: "sent" });
    } catch (err) {
      // 410 Gone — subscription is no longer valid (user unsubscribed or browser cleared)
      if (err.statusCode === 410 || err.statusCode === 404) {
        deadEndpoints.push(sub.endpoint);
        subscriptions.delete(sub);
      }
      results.push({ endpoint: sub.endpoint, status: "error", error: err.message });
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
 * Send a push notification to ALL subscribed browsers.
 * Reusable programmatically (e.g. by the System Guard alert service).
 * Returns { sent, errors, totalSubscriptions }.
 */
export const sendPushToAll = async (title, body, url = "/") => {
  if (!title || !body) {
    throw new Error("Title and body are required");
  }

  const payload = JSON.stringify({ title, body, url });
  const results = [];
  const deadEndpoints = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      results.push({ endpoint: sub.endpoint, status: "sent" });
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        deadEndpoints.push(sub.endpoint);
        subscriptions.delete(sub);
      }
      results.push({ endpoint: sub.endpoint, status: "error", error: err.message });
    }
  }

  if (deadEndpoints.length) {
    console.log(`🧹 Cleaned up ${deadEndpoints.length} dead subscriptions`);
  }

  return {
    sent: results.filter((r) => r.status === "sent").length,
    errors: results.filter((r) => r.status === "error").length,
    totalSubscriptions: subscriptions.size,
  };
};
