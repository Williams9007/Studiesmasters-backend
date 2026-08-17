// ==========================
// SYSTEM ALERT SERVICE
// Sends email + push notifications when the system
// goes down, runs into errors, or detects critical issues.
// ==========================

import { on } from "./systemGuard.js";
import { sendAdminNotification } from "../middleware/sendAdminNotification.js";
import { sendPushToAll } from "../Controllers/pushNotificationController.js";

// ==========================
// CONFIGURATION
// ==========================
const CONFIG = {
  // Cooldown between identical alerts (prevents spam)
  cooldownMs: 5 * 60 * 1000, // 5 minutes
  // Only alert on diagnosis issues at or above this severity
  minDiagnosisSeverity: "warning", // "warning" | "critical"
  // Whether to send push notifications (browser/phone via service worker)
  pushEnabled: true,
  // Whether to send email notifications
  emailEnabled: true,
};

// ==========================
// STATE
// ==========================
const alertHistory = new Map(); // key -> lastSentTimestamp

/**
 * Deduplicate alerts — don't send the same alert more than once per cooldown.
 */
const shouldSendAlert = (key) => {
  const last = alertHistory.get(key);
  if (last && Date.now() - last < CONFIG.cooldownMs) {
    return false;
  }
  alertHistory.set(key, Date.now());

  // Keep history bounded
  if (alertHistory.size > 200) {
    const oldestKey = alertHistory.keys().next().value;
    alertHistory.delete(oldestKey);
  }

  return true;
};

/**
 * Send an alert via email + push notification.
 * @param {Object} opts
 * @param {string} opts.title - Short alert title (e.g. "🚨 System Critical Alert")
 * @param {string} opts.message - Detailed error/issue description
 * @param {string} opts.key - Deduplication key (e.g. "db-down", "heal-failed-database")
 * @param {string} [opts.severity] - "INFO" | "WARNING" | "CRITICAL"
 * @param {string} [opts.url] - URL to open when push notification is clicked
 */
export const sendSystemAlert = async ({
  title,
  message,
  key,
  severity = "WARNING",
  url = "/system-guard",
}) => {
  if (!title || !message || !key) {
    console.warn("⚠️ [SYSTEM ALERT] Missing required fields (title, message, key)");
    return;
  }

  if (!shouldSendAlert(key)) {
    console.log(`⏸️  [SYSTEM ALERT] Suppressed duplicate alert: ${key}`);
    return;
  }

  const timestamp = new Date().toLocaleString();
  const fullMessage = `${message}\n\nTime: ${timestamp}`;

  console.log(`🔔 [SYSTEM ALERT] [${severity}] ${title}`);

  // 1. Send email
  if (CONFIG.emailEnabled) {
    try {
      await sendAdminNotification(`[${severity}] ${title}`, fullMessage);
    } catch (err) {
      console.error("❌ [SYSTEM ALERT] Email send failed:", err.message);
    }
  }

  // 2. Send push notification (browser/phone)
  if (CONFIG.pushEnabled) {
    try {
      const result = await sendPushToAll(title, fullMessage, url);
      console.log(`📱 [SYSTEM ALERT] Push sent: ${result.sent} delivered, ${result.errors} errors`);
    } catch (err) {
      console.error("❌ [SYSTEM ALERT] Push send failed:", err.message);
    }
  }
};

/**
 * Initialize the alert service — subscribes to System Guard events.
 * Call this once during server startup (after initSystemGuard).
 */
export const initSystemAlerts = () => {
  console.log("🔔 [SYSTEM ALERT] Initializing alert service...");

  // --- Diagnosis events (periodic health checks) ---
  on("diagnosis", (diagnosis) => {
    if (!diagnosis || diagnosis.status === "healthy") return;

    const criticalIssues = diagnosis.issues.filter(
      (i) => i.severity === "critical"
    );
    const warningIssues = diagnosis.issues.filter(
      (i) => i.severity === "warning"
    );

    // Critical issues always alert
    if (criticalIssues.length > 0) {
      const details = criticalIssues
        .map((i) => `• ${i.component.toUpperCase()}: ${i.message}`)
        .join("\n");

      sendSystemAlert({
        title: "🚨 System Critical Alert",
        message: `The system detected critical issues:\n\n${details}`,
        key: `diagnosis-critical-${diagnosis.timestamp}`,
        severity: "CRITICAL",
      });
    }

    // Warning issues alert only if configured
    if (
      warningIssues.length > 0 &&
      CONFIG.minDiagnosisSeverity === "warning"
    ) {
      const details = warningIssues
        .map((i) => `• ${i.component.toUpperCase()}: ${i.message}`)
        .join("\n");

      sendSystemAlert({
        title: "⚠️ System Warning",
        message: `The system detected the following issues:\n\n${details}`,
        key: `diagnosis-warning-${diagnosis.timestamp}`,
        severity: "WARNING",
      });
    }
  });

  // --- Healing failures (self-healing could not fix an issue) ---
  on("heal-failed", (data) => {
    sendSystemAlert({
      title: "⚠️ System Healing Failed",
      message: `Self-healing failed for component "${data.component}":\n${data.error || "Unknown error"}`,
      key: `heal-failed-${data.component}`,
      severity: "WARNING",
    });
  });

  // --- Circuit breaker opened (external service failing repeatedly) ---
  on("circuit-breaker-opened", (data) => {
    sendSystemAlert({
      title: "⚠️ Circuit Breaker Opened",
      message: `Service "${data.service}" has been opened after ${data.failures} consecutive failures.`,
      key: `circuit-${data.service}`,
      severity: "WARNING",
    });
  });

  // --- IP blocked (suspicious activity / attacks) ---
  on("ip-blocked", (data) => {
    // Only alert on security-related blocks, not manual admin blocks
    if (data.reason && data.reason !== "Manual block") {
      sendSystemAlert({
        title: "🛡️ Security Alert: IP Blocked",
        message: `IP ${data.ip} was blocked by the firewall.\nReason: ${data.reason}`,
        key: `ip-blocked-${data.ip}-${data.reason}`,
        severity: "WARNING",
      });
    }
  });

  console.log("✅ [SYSTEM ALERT] Alert service initialized");
  console.log(`   📧 Email alerts: ${CONFIG.emailEnabled ? "Enabled" : "Disabled"}`);
  console.log(`   📱 Push alerts: ${CONFIG.pushEnabled ? "Enabled" : "Disabled"}`);
};

export default { initSystemAlerts, sendSystemAlert };