// routes/pushNotificationRoutes.js
import express from "express";
import {
  getVapidPublicKey,
  subscribe,
  unsubscribe,
  sendNotification,
  getSubscriptionCount,
} from "../Controllers/pushNotificationController.js";

const router = express.Router();

// Get the public VAPID key (no auth — needed for subscription)
router.get("/vapidPublicKey", getVapidPublicKey);

// Subscribe to push notifications (no auth — works when logged out)
router.post("/subscribe", subscribe);

// Unsubscribe from push notifications
router.post("/unsubscribe", unsubscribe);

// Send a push notification to all subscribers
router.post("/send", sendNotification);

// Get the number of active subscriptions
router.get("/count", getSubscriptionCount);

export default router;
