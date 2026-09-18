// workers/recording.worker.js
//
// Background worker for recording detection and processing.
// Polls for completed recordings and processes them.

import { processPendingRecordings, detectRecordingForSession, RECORDING_STATUS } from "../services/recording/recording.service.js";
import { poll, complete } from "../services/moodle/queue.js";
import logger from "../utils/logger.js";

const WORKER_INTERVAL_MS = 600000; // 10 minutes

/**
 * Process queued recording detection jobs
 */
async function processRecordingJobs() {
  try {
    const jobs = await poll({ 
      max: 10, 
      types: ["detect-recordings", "process-recording"],
    });

    for (const job of jobs) {
      const runId = job.runId;
      try {
        if (job.type === "detect-recordings" || job.type === "process-recording") {
          const sessionId = job.payload?.sessionId;
          if (sessionId) {
            await detectRecordingForSession(sessionId);
          }
        }
        await complete({ jobId: job._id.toString(), ok: true });
        logger.info(`[WORKER] Recording job completed: ${job._id}`);
      } catch (err) {
        logger.error(`[WORKER] Recording job failed: ${job._id} - ${err.message}`);
        await complete({ jobId: job._id.toString(), ok: false, error: err.message });
      }
    }
  } catch (err) {
    logger.error(`[WORKER] Job polling failed: ${err.message}`);
  }
}

/**
 * Periodic recording scan (finds recordings that need processing)
 */
async function scanForRecordings() {
  try {
    logger.info("[WORKER] Starting recording scan...");
    const results = await processPendingRecordings();
    const processed = results.filter(r => r.found);
    const notFound = results.filter(r => !r.found && !r.error);
    
    if (processed.length > 0) {
      logger.info(`[WORKER] Scan complete: ${processed.length} recordings found`);
    }
    if (notFound.length > 0) {
      logger.info(`[WORKER] Scan complete: ${notFound.length} still pending`);
    }
  } catch (err) {
    logger.error(`[WORKER] Scan failed: ${err.message}`);
  }
}

/**
 * Start the recording worker
 */
export function startRecordingWorker() {
  logger.info("[WORKER] Starting recording worker...");
  
  // Process queued jobs immediately
  processRecordingJobs();
  
  // Set up periodic scanning
  setInterval(() => {
    scanForRecordings();
    processRecordingJobs();
  }, WORKER_INTERVAL_MS);
  
  logger.info(`[WORKER] Recording worker started (interval: ${WORKER_INTERVAL_MS / 60000}min)`);
  
  // Initial scan after startup
  setTimeout(scanForRecordings, 5000);
}

/**
 * Stop the worker (cleanup)
 */
export function stopRecordingWorker() {
  logger.info("[WORKER] Stopping recording worker...");
  // Cleanup if needed
}

// Auto-start if run directly
const isMainModule = process.argv[1]?.includes("recording.worker.js") || 
                     process.argv[1]?.endsWith("workers/recording.worker.js");

if (isMainModule) {
  startRecordingWorker();
  
  // Graceful shutdown
  process.on("SIGTERM", () => {
    logger.info("[WORKER] Received SIGTERM, shutting down...");
    stopRecordingWorker();
    process.exit(0);
  });
  
  process.on("SIGINT", () => {
    logger.info("[WORKER] Received SIGINT, shutting down...");
    stopRecordingWorker();
    process.exit(0);
  });
}

export default { startRecordingWorker, stopRecordingWorker };