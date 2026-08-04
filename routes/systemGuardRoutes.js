// ==========================
// SYSTEM GUARD - Secure Remote Admin Routes
// Protected by adminAuth middleware
// ==========================

import express from "express";
import { adminAuth } from "../middleware/adminAuth.js";
import {
  getSystemStatus,
  runDiagnosis,
  runHealing,
  blockIP,
  unblockIP,
  getMemoryUsage,
  getCPUUsage,
  getSystemInfo,
  state,
  CONFIG,
} from "../services/systemGuard.js";

const router = express.Router();

// All routes require admin authentication
router.use(adminAuth);

// ==========================
// SYSTEM STATUS
// ==========================
router.get("/status", async (req, res) => {
  try {
    const status = await getSystemStatus();
    // Always return 200 - the status info is in the response body
    res.status(200).json(status);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==========================
// RUN DIAGNOSIS
// ==========================
router.post("/diagnosis", async (req, res) => {
  try {
    const diagnosis = await runDiagnosis();
    res.json({ success: true, diagnosis });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================
// RUN HEALING
// ==========================
router.post("/healing", async (req, res) => {
  try {
    const diagnosis = await runDiagnosis();
    const result = await runHealing(diagnosis);
    res.json({ success: true, healing: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================
// BLOCK IP
// ==========================
router.post("/block-ip", (req, res) => {
  const { ip, reason } = req.body;
  if (!ip) return res.status(400).json({ success: false, message: "IP is required" });
  blockIP(ip, reason || "Admin block via remote dashboard");
  res.json({ success: true, message: `IP ${ip} blocked`, blockedIPs: Array.from(state.blockedIPs) });
});

// ==========================
// UNBLOCK IP
// ==========================
router.post("/unblock-ip", (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ success: false, message: "IP is required" });
  unblockIP(ip);
  res.json({ success: true, message: `IP ${ip} unblocked`, blockedIPs: Array.from(state.blockedIPs) });
});

// ==========================
// LIST BLOCKED IPS
// ==========================
router.get("/blocked-ips", (req, res) => {
  res.json({
    success: true,
    blockedIPs: Array.from(state.blockedIPs),
    count: state.blockedIPs.size,
  });
});

// ==========================
// CONFIGURATION
// ==========================
router.get("/config", (req, res) => {
  res.json({
    success: true,
    config: {
      firewall: {
        enabled: CONFIG.firewall.enabled,
        maxRequestsPerMinute: CONFIG.firewall.maxRequestsPerMinute,
        maxRequestsPerSecond: CONFIG.firewall.maxRequestsPerSecond,
      },
      diagnosis: {
        enabled: CONFIG.diagnosis.enabled,
        checkIntervalMs: CONFIG.diagnosis.checkIntervalMs,
        memoryThresholdMB: CONFIG.diagnosis.memoryThresholdMB,
        cpuThresholdPercent: CONFIG.diagnosis.cpuThresholdPercent,
        responseTimeThresholdMs: CONFIG.diagnosis.responseTimeThresholdMs,
      },
      healing: {
        enabled: CONFIG.healing.enabled,
        maxRetries: CONFIG.healing.maxRetries,
        cooldownMs: CONFIG.healing.cooldownMs,
      },
    },
  });
});

// ==========================
// METRICS HISTORY
// ==========================
router.get("/metrics", (req, res) => {
  res.json({
    success: true,
    memoryHistory: state.metrics.memoryUsage.slice(-20),
    cpuHistory: state.metrics.cpuUsage.slice(-20),
    recentWarnings: state.metrics.warnings.slice(-20),
    recentErrors: state.metrics.errors.slice(-20),
    healingHistory: state.healingHistory.slice(-10),
  });
});

export default router;