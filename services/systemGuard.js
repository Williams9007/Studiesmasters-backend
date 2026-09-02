// ==========================
// SYSTEM GUARD
// Firewall + Self-Diagnosis + Self-Healing Engine
// ==========================

import mongoose from "mongoose";
import { performance } from "perf_hooks";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================
// CONFIGURATION
// ==========================
const CONFIG = {
  // Firewall
  firewall: {
    enabled: true,
    maxRequestsPerMinute: 600,
    maxRequestsPerSecond: 30,
    suspiciousPatterns: [
      /(\b(select|union|insert|drop|delete|alter|exec|declare|truncate|update)\b.*\b(from|into|set|where|table|database)\b)/i,
      /(<script|<\/script|javascript:|onerror=|onload=|onclick=)/i,
      /(\b(rm\s+-rf|wget\s+|curl\s+|powershell\s+|cmd\.exe|bash\s+|sh\s+-c)\b)/i,
      /(%27|%22|%3C|%3E|%3B|%00)/i,
      /(\b(admin|root|system|config|passwd|shadow)\b\s*[=:]\s*\S+)/i,
    ],
    blockedIPs: new Set(), // Permanent manual blocks (only via system-guard UI)
    autoBlockDurationMs: 15 * 60 * 1000, // Auto-unblock firewall-blocked IPs after 15 minutes
    blockedUserAgents: [
      /curl/i,
      /wget/i,
      /python-requests/i,
      /go-http-client/i,
      /scrapy/i,
      /nikto/i,
      /sqlmap/i,
      /nmap/i,
    ],
    maxBodySize: "10mb",
  },

  // Diagnosis
  diagnosis: {
    enabled: true,
    checkIntervalMs: 30000, // Check every 30 seconds
    memoryThresholdMB: 500, // Alert if RSS exceeds this
    cpuThresholdPercent: 80, // Alert if CPU > 80%
    responseTimeThresholdMs: 5000, // Alert if response time > 5s
    errorRateThreshold: 0.1, // Alert if error rate > 10%
    dbPingIntervalMs: 15000, // Ping DB every 15 seconds
    maxEventLoopLagMs: 200, // Alert if event loop lag > 200ms
  },

  // Self-Healing
  healing: {
    enabled: true,
    maxRetries: 3,
    cooldownMs: 60000, // Wait 1 min between healing attempts
    autoRestartOnCritical: true,
    cleanupStaleConnections: true,
    staleConnectionThresholdMs: 300000, // 5 minutes
  },
};

// ==========================
// STATE
// ==========================
const state = {
  // Firewall state
  requestCounts: new Map(), // IP -> { count, windowStart }
  blockedIPs: new Map(), // IP -> { timestamp, reason } (auto-expiring)
  suspiciousActivity: new Map(), // IP -> [timestamps]

  // Diagnosis state
  metrics: {
    startTime: Date.now(),
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalResponseTime: 0,
    maxResponseTime: 0,
    minResponseTime: Infinity,
    memoryUsage: [],
    cpuUsage: [],
    dbConnected: false,
    lastDbPing: null,
    lastDbPingDuration: null,
    eventLoopLag: 0,
    activeConnections: 0,
    lastCheckTimestamp: null,
    errors: [],
    warnings: [],
  },

  // Healing state
  healingInProgress: false,
  lastHealingAttempt: null,
  healingHistory: [],
  circuitBreakers: new Map(), // service -> { failures, lastFailure, state }
  dbReconnectAttempts: 0,
};

// ==========================
// EVENT EMITTER (for notifications)
// ==========================
const listeners = new Map();

const on = (event, callback) => {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(callback);
};

const emit = (event, data) => {
  const cbs = listeners.get(event);
  if (cbs) cbs.forEach((cb) => cb(data));
};


// ==========================
// FIREWALL ENGINE
// ==========================

/**
 * Check if an IP is blocked
 */
const isIPBlocked = (ip) => {
  // Permanent manual block (via system-guard UI)
  if (CONFIG.firewall.blockedIPs.has(ip)) return true;

  // Auto-expiring firewall block
  const block = state.blockedIPs.get(ip);
  if (!block) return false;

  // Auto-unblock after the cooldown period so legit users are never locked out
  const elapsed = Date.now() - block.timestamp;
  if (elapsed > CONFIG.firewall.autoBlockDurationMs) {
    state.blockedIPs.delete(ip);
    console.log(`✅ [SYSTEM GUARD] Auto-unblocked IP: ${ip} (after ${Math.round(elapsed / 60000)} min)`);
    return false;
  }

  return true;
};

/**
 * Block an IP address
 */
const blockIP = (ip, reason = "Manual block") => {
  state.blockedIPs.set(ip, { timestamp: Date.now(), reason });
  state.metrics.warnings.push({
    type: "IP_BLOCKED",
    ip,
    reason,
    timestamp: new Date().toISOString(),
  });
  emit("ip-blocked", { ip, reason });
  console.warn(`🚫 [SYSTEM GUARD] Blocked IP: ${ip} - Reason: ${reason}`);
};

/**
 * Unblock an IP address
 */
const unblockIP = (ip) => {
  state.blockedIPs.delete(ip);
  console.log(`✅ [SYSTEM GUARD] Unblocked IP: ${ip}`);
};

/**
 * Check request for suspicious patterns
 */
const checkSuspiciousPatterns = (body, url, headers) => {
  const combined = JSON.stringify({ body, url });
  for (const pattern of CONFIG.firewall.suspiciousPatterns) {
    if (pattern.test(combined)) {
      return true;
    }
  }
  return false;
};

/**
 * Check if user agent is blocked
 */
const isBlockedUserAgent = (userAgent) => {
  if (!userAgent) return false;
  for (const pattern of CONFIG.firewall.blockedUserAgents) {
    if (pattern.test(userAgent)) return true;
  }
  return false;
};

/**
 * Rate limit check
 */
const checkRateLimit = (ip) => {
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const secondWindowMs = 1000; // 1 second

  let entry = state.requestCounts.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, secondCount: 0, secondWindowStart: now, windowStart: now };
    state.requestCounts.set(ip, entry);
  }

  entry.count++;

  // Per-second check
  if (now - entry.secondWindowStart > secondWindowMs) {
    entry.secondCount = 0;
    entry.secondWindowStart = now;
  }
  entry.secondCount++;

  if (entry.count > CONFIG.firewall.maxRequestsPerMinute) {
    return { blocked: true, reason: "Rate limit exceeded (per minute)" };
  }

  if (entry.secondCount > CONFIG.firewall.maxRequestsPerSecond) {
    return { blocked: true, reason: "Rate limit exceeded (per second)" };
  }

  return { blocked: false };
};

// Paths that bypass firewall (auth routes, static files, system guard dashboard,
// and JWT-protected admin API routes which already use adminAuth middleware)
const BYPASS_PATHS = [
  "/api/admin", // Admin routes are JWT-protected via adminAuth middleware
  "/api/qao", // QAO/Tutor Manager routes are JWT-protected via verifyQao middleware
  "/api/teachers", // Teacher routes
  "/api/payments", // Payment routes (Paystack initialize/verify) must not be firewall-blocked
  "/api/students", // Student routes (payment-summary, etc.)
  "/api/moodle", // Moodle SSO routes are JWT-protected via studentAuth/verifyTeacher
  "/api/system-guard", // System guard dashboard routes
  "/api/system", // System guard unblock/block API endpoints (must be accessible even when IP is blocked)
  "/system-guard.html",
  "/favicon.ico",
  "/health",
  "/uploads",
];

/**
 * Express middleware: Firewall
 */
const firewallMiddleware = (req, res, next) => {
  if (!CONFIG.firewall.enabled) return next();

  // Skip firewall for auth and static paths
  const path = req.path || req.originalUrl || "";
  for (const bypass of BYPASS_PATHS) {
    if (path.startsWith(bypass)) {
      return next();
    }
  }

  const ip = req.ip || req.connection?.remoteAddress || "unknown";

  // Check if IP is blocked
  if (isIPBlocked(ip)) {
    return res.status(403).json({
      success: false,
      message: "Access denied. Your IP has been blocked.",
      code: "IP_BLOCKED",
    });
  }

  // Check user agent
  const userAgent = req.headers["user-agent"];
  if (isBlockedUserAgent(userAgent)) {
    blockIP(ip, "Blocked user agent");
    return res.status(403).json({
      success: false,
      message: "Access denied.",
      code: "BLOCKED_USER_AGENT",
    });
  }

  // Rate limit check
  const rateCheck = checkRateLimit(ip);
  if (rateCheck.blocked) {
    state.metrics.warnings.push({
      type: "RATE_LIMIT",
      ip,
      reason: rateCheck.reason,
      timestamp: new Date().toISOString(),
    });
    return res.status(429).json({
      success: false,
      message: rateCheck.reason,
      code: "RATE_LIMIT",
    });
  }

  // Check suspicious patterns in request body/query
  if (req.body && Object.keys(req.body).length > 0) {
    if (checkSuspiciousPatterns(req.body, req.originalUrl, req.headers)) {
      blockIP(ip, "Suspicious request pattern detected");
      return res.status(403).json({
        success: false,
        message: "Suspicious request detected.",
        code: "SUSPICIOUS_REQUEST",
      });
    }
  }

  // Track request for metrics
  state.metrics.totalRequests++;
  state.metrics.activeConnections++;

  const startTime = performance.now();

  // Override res.end to track response time (only for non-auth routes)
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = performance.now() - startTime;
    state.metrics.totalResponseTime += duration;
    state.metrics.activeConnections--;

    if (duration > state.metrics.maxResponseTime) {
      state.metrics.maxResponseTime = duration;
    }
    if (duration < state.metrics.minResponseTime) {
      state.metrics.minResponseTime = duration;
    }

    if (res.statusCode >= 400) {
      state.metrics.failedRequests++;
    } else {
      state.metrics.successfulRequests++;
    }

    // Alert on slow responses
    if (duration > CONFIG.diagnosis.responseTimeThresholdMs) {
      state.metrics.warnings.push({
        type: "SLOW_RESPONSE",
        path: req.originalUrl,
        method: req.method,
        duration: `${duration.toFixed(2)}ms`,
        timestamp: new Date().toISOString(),
      });
    }

    return originalEnd.apply(this, args);
  };

  next();
};

// ==========================
// DIAGNOSIS ENGINE
// ==========================

/**
 * Get current memory usage
 */
const getMemoryUsage = () => {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024 * 100) / 100, // MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    external: Math.round(usage.external / 1024 / 1024 * 100) / 100,
    arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024 * 100) / 100,
  };
};

/**
 * Get CPU usage
 */
const getCPUUsage = () => {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach((cpu) => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });

  const idlePercent = (totalIdle / totalTick) * 100;
  const usagePercent = 100 - idlePercent;

  return {
    usagePercent: Math.round(usagePercent * 100) / 100,
    cores: cpus.length,
    loadAverage: os.loadavg(),
  };
};

/**
 * Get system info
 */
const getSystemInfo = () => {
  return {
    platform: os.platform(),
    hostname: os.hostname(),
    arch: os.arch(),
    uptime: os.uptime(),
    totalMemory: Math.round(os.totalmem() / 1024 / 1024 * 100) / 100,
    freeMemory: Math.round(os.freemem() / 1024 / 1024 * 100) / 100,
    cpus: os.cpus().length,
    nodeVersion: process.version,
    pid: process.pid,
  };
};

/**
 * Ping database
 */
const pingDatabase = async () => {
  const start = performance.now();
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      state.metrics.lastDbPingDuration = performance.now() - start;
      state.metrics.lastDbPing = new Date().toISOString();
      state.metrics.dbConnected = true;
      return true;
    }
    state.metrics.dbConnected = false;
    return false;
  } catch (error) {
    state.metrics.dbConnected = false;
    state.metrics.errors.push({
      type: "DB_PING_FAILED",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
    return false;
  }
};

/**
 * Measure event loop lag
 */
const measureEventLoopLag = () => {
  return new Promise((resolve) => {
    const start = performance.now();
    setImmediate(() => {
      const lag = performance.now() - start;
      state.metrics.eventLoopLag = lag;
      resolve(lag);
    });
  });
};

/**
 * Run full diagnosis
 */
const runDiagnosis = async () => {
  const diagnosis = {
    timestamp: new Date().toISOString(),
    status: "healthy",
    issues: [],
    metrics: {},
  };

  // 1. Check database
  const dbOk = await pingDatabase();
  if (!dbOk) {
    diagnosis.issues.push({
      severity: "critical",
      component: "database",
      message: "Database is not connected or unreachable",
    });
    diagnosis.status = "degraded";
  }

  // 2. Check memory
  const mem = getMemoryUsage();
  diagnosis.metrics.memory = mem;
  if (mem.rss > CONFIG.diagnosis.memoryThresholdMB) {
    diagnosis.issues.push({
      severity: "warning",
      component: "memory",
      message: `Memory usage high: ${mem.rss}MB (threshold: ${CONFIG.diagnosis.memoryThresholdMB}MB)`,
      value: mem.rss,
      threshold: CONFIG.diagnosis.memoryThresholdMB,
    });
    if (diagnosis.status === "healthy") diagnosis.status = "degraded";
  }

  // 3. Check CPU
  const cpu = getCPUUsage();
  diagnosis.metrics.cpu = cpu;
  if (cpu.usagePercent > CONFIG.diagnosis.cpuThresholdPercent) {
    diagnosis.issues.push({
      severity: "warning",
      component: "cpu",
      message: `CPU usage high: ${cpu.usagePercent}% (threshold: ${CONFIG.diagnosis.cpuThresholdPercent}%)`,
      value: cpu.usagePercent,
      threshold: CONFIG.diagnosis.cpuThresholdPercent,
    });
    if (diagnosis.status === "healthy") diagnosis.status = "degraded";
  }

  // 4. Check event loop lag
  const lag = await measureEventLoopLag();
  diagnosis.metrics.eventLoopLag = lag;
  if (lag > CONFIG.diagnosis.maxEventLoopLagMs) {
    diagnosis.issues.push({
      severity: "warning",
      component: "eventLoop",
      message: `Event loop lag high: ${lag.toFixed(2)}ms (threshold: ${CONFIG.diagnosis.maxEventLoopLagMs}ms)`,
      value: lag,
      threshold: CONFIG.diagnosis.maxEventLoopLagMs,
    });
    if (diagnosis.status === "healthy") diagnosis.status = "degraded";
  }

  // 5. Check error rate
  const totalReqs = state.metrics.totalRequests || 1;
  const errorRate = state.metrics.failedRequests / totalReqs;
  diagnosis.metrics.errorRate = errorRate;
  if (errorRate > CONFIG.diagnosis.errorRateThreshold) {
    diagnosis.issues.push({
      severity: "critical",
      component: "errors",
      message: `Error rate high: ${(errorRate * 100).toFixed(2)}% (threshold: ${(CONFIG.diagnosis.errorRateThreshold * 100).toFixed(2)}%)`,
      value: errorRate,
      threshold: CONFIG.diagnosis.errorRateThreshold,
    });
    diagnosis.status = "critical";
  }

  // 6. Check response times
  const avgResponseTime = totalReqs > 0
    ? state.metrics.totalResponseTime / totalReqs
    : 0;
  diagnosis.metrics.avgResponseTime = avgResponseTime;
  diagnosis.metrics.maxResponseTime = state.metrics.maxResponseTime;
  diagnosis.metrics.minResponseTime = state.metrics.minResponseTime === Infinity ? 0 : state.metrics.minResponseTime;

  // 7. Check system resources
  const sysInfo = getSystemInfo();
  diagnosis.metrics.system = {
    uptime: sysInfo.uptime,
    freeMemory: sysInfo.freeMemory,
    totalMemory: sysInfo.totalMemory,
    loadAverage: sysInfo.loadAverage,
  };

  // Store metrics history (keep last 100)
  state.metrics.memoryUsage.push({ ...mem, timestamp: diagnosis.timestamp });
  if (state.metrics.memoryUsage.length > 100) state.metrics.memoryUsage.shift();

  state.metrics.cpuUsage.push({ ...cpu, timestamp: diagnosis.timestamp });
  if (state.metrics.cpuUsage.length > 100) state.metrics.cpuUsage.shift();

  state.metrics.lastCheckTimestamp = diagnosis.timestamp;

  // Emit diagnosis event
  emit("diagnosis", diagnosis);

  return diagnosis;
};

// ==========================
// SELF-HEALING ENGINE
// ==========================

/**
 * Attempt to reconnect to database
 * Uses process.env.MONGO_URI (already built in server.js) to avoid host mismatch
 */
const healDatabase = async () => {
  // Don't attempt reconnection if already connected
  if (mongoose.connection.readyState === 1) {
    state.metrics.dbConnected = true;
    state.dbReconnectAttempts = 0;
    return true;
  }

  // Max 3 reconnection attempts to prevent infinite loop
  if (state.dbReconnectAttempts >= 3) {
    console.warn(`⏸️  [SYSTEM GUARD] Max database reconnection attempts (${state.dbReconnectAttempts}) reached. Skipping further attempts.`);
    return false;
  }

  console.log("🔄 [SYSTEM GUARD] Attempting database reconnection...");
  try {
    await mongoose.disconnect();
    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error("MONGO_URI is not set");
    }
    await mongoose.connect(uri);
    state.metrics.dbConnected = true;
    state.dbReconnectAttempts = 0;
    console.log("✅ [SYSTEM GUARD] Database reconnected successfully");
    emit("healed", { component: "database", action: "reconnected" });
    return true;
  } catch (error) {
    state.dbReconnectAttempts++;
    console.error(`❌ [SYSTEM GUARD] Database reconnection failed (attempt ${state.dbReconnectAttempts}):`, error.message);
    emit("heal-failed", { component: "database", error: error.message });
    return false;
  }
};

/**
 * Clear memory pressure
 */
const healMemory = () => {
  console.log("🔄 [SYSTEM GUARD] Attempting memory cleanup...");
  try {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.log("✅ [SYSTEM GUARD] Garbage collection triggered");
    }

    // Clear request count map periodically
    const now = Date.now();
    for (const [ip, entry] of state.requestCounts.entries()) {
      if (now - entry.windowStart > 120000) { // 2 minutes
        state.requestCounts.delete(ip);
      }
    }

    // Trim metrics arrays
    if (state.metrics.errors.length > 50) {
      state.metrics.errors = state.metrics.errors.slice(-50);
    }
    if (state.metrics.warnings.length > 50) {
      state.metrics.warnings = state.metrics.warnings.slice(-50);
    }

    emit("healed", { component: "memory", action: "cleanup" });
    return true;
  } catch (error) {
    console.error("❌ [SYSTEM GUARD] Memory cleanup failed:", error.message);
    return false;
  }
};

/**
 * Circuit breaker for external services
 */
const circuitBreaker = (serviceName) => {
  let breaker = state.circuitBreakers.get(serviceName);
  if (!breaker) {
    breaker = {
      failures: 0,
      lastFailure: null,
      state: "closed", // closed, open, half-open
      lastStateChange: Date.now(),
    };
    state.circuitBreakers.set(serviceName, breaker);
  }

  return {
    isOpen: () => breaker.state === "open",

    recordSuccess: () => {
      breaker.failures = 0;
      if (breaker.state === "half-open") {
        breaker.state = "closed";
        breaker.lastStateChange = Date.now();
        console.log(`✅ [SYSTEM GUARD] Circuit breaker '${serviceName}' reset to closed`);
      }
    },

    recordFailure: () => {
      breaker.failures++;
      breaker.lastFailure = Date.now();
      if (breaker.failures >= CONFIG.healing.maxRetries) {
        breaker.state = "open";
        breaker.lastStateChange = Date.now();
        console.warn(`🚫 [SYSTEM GUARD] Circuit breaker '${serviceName}' opened after ${breaker.failures} failures`);
        emit("circuit-breaker-opened", { service: serviceName, failures: breaker.failures });
      }
    },

    attemptReset: () => {
      if (breaker.state === "open" && Date.now() - breaker.lastStateChange > CONFIG.healing.cooldownMs) {
        breaker.state = "half-open";
        breaker.lastStateChange = Date.now();
        console.log(`🔄 [SYSTEM GUARD] Circuit breaker '${serviceName}' attempting half-open`);
        return true;
      }
      return false;
    },

    getState: () => ({ ...breaker }),
  };
};

/**
 * Main healing orchestrator
 */
const runHealing = async (diagnosis) => {
  if (!CONFIG.healing.enabled) return;
  if (state.healingInProgress) {
    console.log("⏳ [SYSTEM GUARD] Healing already in progress, skipping...");
    return;
  }

  // Cooldown check
  if (state.lastHealingAttempt && Date.now() - state.lastHealingAttempt < CONFIG.healing.cooldownMs) {
    return;
  }

  state.healingInProgress = true;
  state.lastHealingAttempt = Date.now();

  const healingResult = {
    timestamp: new Date().toISOString(),
    actions: [],
    success: true,
  };

  try {
    for (const issue of diagnosis.issues) {
      switch (issue.component) {
        case "database":
          if (issue.severity === "critical") {
            const dbHealed = await healDatabase();
            healingResult.actions.push({
              component: "database",
              action: "reconnect",
              success: dbHealed,
            });
            if (!dbHealed) healingResult.success = false;
          }
          break;

        case "memory":
          const memHealed = healMemory();
          healingResult.actions.push({
            component: "memory",
            action: "cleanup",
            success: memHealed,
          });
          break;

        case "eventLoop":
          // For event loop lag, try memory cleanup
          const elHealed = healMemory();
          healingResult.actions.push({
            component: "eventLoop",
            action: "memory-cleanup",
            success: elHealed,
          });
          break;

        case "cpu":
          // For high CPU, log and monitor
          healingResult.actions.push({
            component: "cpu",
            action: "monitoring",
            success: true,
            note: "High CPU detected, continuing to monitor",
          });
          break;

        case "errors":
          // For high error rate, try clearing caches
          healingResult.actions.push({
            component: "errors",
            action: "cache-clear",
            success: true,
            note: "Error rate threshold exceeded, monitoring continued",
          });
          break;
      }
    }

    state.healingHistory.push(healingResult);
    if (state.healingHistory.length > 20) state.healingHistory.shift();

    emit("healing-completed", healingResult);

    if (healingResult.success) {
      console.log("✅ [SYSTEM GUARD] Healing completed successfully");
    } else {
      console.warn("⚠️ [SYSTEM GUARD] Healing completed with some failures");
    }
  } catch (error) {
    console.error("❌ [SYSTEM GUARD] Healing error:", error.message);
    healingResult.success = false;
    healingResult.error = error.message;
  } finally {
    state.healingInProgress = false;
  }

  return healingResult;
};

// ==========================
// DIAGNOSTIC LOOP
// ==========================

let diagnosisInterval = null;
let dbPingInterval = null;

/**
 * Start the diagnostic monitoring loop
 */
const startMonitoring = () => {
  if (!CONFIG.diagnosis.enabled) return;

  console.log("🔍 [SYSTEM GUARD] Starting monitoring system...");

  // Run diagnosis on interval
  diagnosisInterval = setInterval(async () => {
    try {
      const diagnosis = await runDiagnosis();

      // If issues found, attempt healing
      if (diagnosis.issues.length > 0 && CONFIG.healing.enabled) {
        console.log(`🔧 [SYSTEM GUARD] ${diagnosis.issues.length} issue(s) detected, initiating healing...`);
        await runHealing(diagnosis);
      }
    } catch (error) {
      console.error("❌ [SYSTEM GUARD] Diagnosis error:", error.message);
    }
  }, CONFIG.diagnosis.checkIntervalMs);

  // Ping database more frequently
  dbPingInterval = setInterval(async () => {
    await pingDatabase();
  }, CONFIG.diagnosis.dbPingIntervalMs);

  // Initial diagnosis
  setTimeout(async () => {
    const diagnosis = await runDiagnosis();
    if (diagnosis.issues.length > 0) {
      console.log(`🔧 [SYSTEM GUARD] Initial diagnosis found ${diagnosis.issues.length} issue(s)`);
      await runHealing(diagnosis);
    } else {
      console.log("✅ [SYSTEM GUARD] Initial diagnosis: All systems healthy");
    }
  }, 2000);
};

/**
 * Stop the monitoring loop
 */
const stopMonitoring = () => {
  if (diagnosisInterval) {
    clearInterval(diagnosisInterval);
    diagnosisInterval = null;
  }
  if (dbPingInterval) {
    clearInterval(dbPingInterval);
    dbPingInterval = null;
  }
  console.log("⏹️  [SYSTEM GUARD] Monitoring stopped");
};

// ==========================
// API / STATUS ENDPOINT
// ==========================

/**
 * Get full system status report
 */
const getSystemStatus = async () => {
  const diagnosis = await runDiagnosis();
  const mem = getMemoryUsage();
  const cpu = getCPUUsage();

  return {
    status: diagnosis.status,
    uptime: {
      server: Math.floor((Date.now() - state.metrics.startTime) / 1000),
      system: os.uptime(),
    },
    system: getSystemInfo(),
    database: {
      connected: state.metrics.dbConnected,
      lastPing: state.metrics.lastDbPing,
      lastPingDuration: state.metrics.lastDbPingDuration
        ? `${state.metrics.lastDbPingDuration.toFixed(2)}ms`
        : null,
    },
    performance: {
      memory: mem,
      cpu: cpu,
      eventLoopLag: `${state.metrics.eventLoopLag.toFixed(2)}ms`,
      avgResponseTime: state.metrics.totalRequests > 0
        ? `${(state.metrics.totalResponseTime / state.metrics.totalRequests).toFixed(2)}ms`
        : "0ms",
      maxResponseTime: state.metrics.maxResponseTime > 0
        ? `${state.metrics.maxResponseTime.toFixed(2)}ms`
        : "0ms",
      minResponseTime: state.metrics.minResponseTime < Infinity
        ? `${state.metrics.minResponseTime.toFixed(2)}ms`
        : "0ms",
    },
    requests: {
      total: state.metrics.totalRequests,
      successful: state.metrics.successfulRequests,
      failed: state.metrics.failedRequests,
      errorRate: state.metrics.totalRequests > 0
        ? `${((state.metrics.failedRequests / state.metrics.totalRequests) * 100).toFixed(2)}%`
        : "0%",
      activeConnections: state.metrics.activeConnections,
    },
    firewall: {
      enabled: CONFIG.firewall.enabled,
      blockedIPs: state.blockedIPs.size,
      activeRateLimitEntries: state.requestCounts.size,
    },
    healing: {
      enabled: CONFIG.healing.enabled,
      inProgress: state.healingInProgress,
      lastAttempt: state.lastHealingAttempt,
      historyCount: state.healingHistory.length,
      dbReconnectAttempts: state.dbReconnectAttempts,
    },
    issues: diagnosis.issues,
    recentWarnings: state.metrics.warnings.slice(-10),
    recentErrors: state.metrics.errors.slice(-10),
    timestamp: new Date().toISOString(),
  };
};

/**
 * Express middleware: System status endpoint
 */
const statusEndpoint = async (req, res) => {
  try {
    const status = await getSystemStatus();
    const httpStatus = status.status === "healthy" ? 200 : status.status === "degraded" ? 200 : 503;
    res.status(httpStatus).json(status);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};

// ==========================
// INITIALIZATION
// ==========================

/**
 * Initialize the System Guard
 */
const init = (app) => {
  console.log("🛡️  [SYSTEM GUARD] Initializing...");

  // Apply firewall middleware
  if (CONFIG.firewall.enabled) {
    app.use(firewallMiddleware);
    console.log("🛡️  [SYSTEM GUARD] Firewall middleware applied");
  }

  // Add system status endpoint
  app.get("/api/system/status", statusEndpoint);

  // Add system guard admin endpoints
  app.post("/api/system/block-ip", (req, res) => {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: "IP is required" });
    blockIP(ip, reason || "Admin block");
    res.json({ success: true, message: `IP ${ip} blocked` });
  });

  app.post("/api/system/unblock-ip", (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: "IP is required" });
    unblockIP(ip);
    res.json({ success: true, message: `IP ${ip} unblocked` });
  });

  app.get("/api/system/blocked-ips", (req, res) => {
    res.json({
      success: true,
      blockedIPs: Array.from(state.blockedIPs.keys()),
    });
  });

  app.post("/api/system/run-diagnosis", async (req, res) => {
    const diagnosis = await runDiagnosis();
    res.json({ success: true, diagnosis });
  });

  app.post("/api/system/run-healing", async (req, res) => {
    const diagnosis = await runDiagnosis();
    const result = await runHealing(diagnosis);
    res.json({ success: true, healing: result });
  });

  app.get("/api/system/config", (req, res) => {
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

  // Start monitoring
  startMonitoring();

  console.log("✅ [SYSTEM GUARD] Initialized successfully");
  console.log(`   🔍 Diagnosis interval: ${CONFIG.diagnosis.checkIntervalMs / 1000}s`);
  console.log(`   🛡️  Firewall: ${CONFIG.firewall.enabled ? "Active" : "Disabled"}`);
  console.log(`   🔧 Self-Healing: ${CONFIG.healing.enabled ? "Active" : "Disabled"}`);

  emit("initialized", { timestamp: new Date().toISOString() });
};

// ==========================
// EXPORTS
// ==========================

export {
  init,
  getSystemStatus,
  runDiagnosis,
  runHealing,
  blockIP,
  unblockIP,
  isIPBlocked,
  firewallMiddleware,
  statusEndpoint,
  circuitBreaker,
  on,
  getMemoryUsage,
  getCPUUsage,
  getSystemInfo,
  pingDatabase,
  CONFIG,
  state,
};