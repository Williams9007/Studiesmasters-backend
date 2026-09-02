// services/moodle/index.js
//
// Facade over the Moodle service layer so controllers/routes import one module.
import { config, secrets } from "./config.js";
import { createUser } from "./createUser.js";
import { updateUser } from "./updateUser.js";
import { enrollUser } from "./enrollUser.js";
import { unenrollUser } from "./unenrollUser.js";
import { suspendUser } from "./suspendUser.js";
import { syncProfile, syncEnrollments } from "./syncProfile.js";
import { generateSSO } from "./generateSSO.js";
import { verifySSO } from "./verifySSO.js";
import { getCourseIdsFor, listMappings, upsertMapping, removeMapping } from "./courseMapper.js";
import { runReconciliation } from "./reconciliation.js";
import { provisionStructure, provisionStatus } from "./provisioning.js";
import { syncAllStudents, queueSnapshot } from "./bulkSync.js";
import { enqueue } from "./queue.js";
import { health, bump } from "./metrics.js";
import { processQueueBatch, startWorker } from "./worker.js";
import { store } from "./store.js";
import { resolveStudentAccess, resolveSubjects } from "./accessResolver.js";
import { recordSyncStatus, syncOverview, listWarnings, retryFailedSyncs } from "./syncStatus.js";

export const moodle = {
  config,
  secrets,
  createUser,
  updateUser,
  enrollUser,
  unenrollUser,
  suspendUser,
  syncProfile,
  syncEnrollments,
  generateSSO,
  verifySSO,
  getCourseIdsFor,
  listMappings,
  upsertMapping,
  removeMapping,
  runReconciliation,
  provisionStructure,
  provisionStatus,
  syncAllStudents,
  queueSnapshot,
  resolveStudentAccess,
  resolveSubjects,
  recordSyncStatus,
  syncOverview,
  listWarnings,
  retryFailedSyncs,
  enqueue,
  health,
  bumpMetrics: bump,
  processQueueBatch,
  startWorker,
  store,
};

export {
  config, secrets, createUser, updateUser, enrollUser, unenrollUser, suspendUser,
  syncProfile, syncEnrollments, generateSSO, verifySSO, getCourseIdsFor,
  listMappings, upsertMapping, removeMapping, runReconciliation, enqueue, health,
  provisionStructure, provisionStatus, syncAllStudents, queueSnapshot,
  resolveStudentAccess, resolveSubjects, recordSyncStatus, syncOverview,
  listWarnings, retryFailedSyncs,
  bump as bumpMetrics, processQueueBatch, startWorker, store,
};

export default moodle;