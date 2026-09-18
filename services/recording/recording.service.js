// services/recording/recording.service.js
// Recording lifecycle management service
import Recording from '../../models/Recording.js';
import ClassSession from '../../models/ClassSession.js';
import { logAccess } from '../../models/RecordingAccessLog.js';
import { enqueue } from '../moodle/queue.js';
import { drive } from '../google/index.js';

export const RECORDING_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  AVAILABLE: 'available',
  FAILED: 'failed',
  ARCHIVED: 'archived',
};

export async function initializeRecording(sessionId) {
  const session = await ClassSession.findById(sessionId);
  if (!session) throw new Error('Session not found');
  const recording = await Recording.findOne({ sessionId });
  if (recording?.driveFileId) return { success: true, existing: true, recording };
  const newRecording = new Recording({ sessionId, status: RECORDING_STATUS.PENDING });
  await newRecording.save();
  await enqueue({ type: 'detect-recordings', payload: { sessionId }, idempotencyKey: 'detect:' + sessionId, maxAttempts: 5, backoffMs: 60000 });
  return { success: true, existing: false, recording: newRecording, queued: true };
}

export async function markRecordingProcessing(sessionId, driveFileId) {
  const recording = await Recording.findOne({ sessionId });
  if (!recording) throw new Error('Recording not found');
  recording.status = RECORDING_STATUS.PROCESSING;
  recording.driveFileId = driveFileId;
  recording.processedAt = new Date();
  await recording.save();
  return { success: true, recording };
}

export async function completeRecordingProcessing(sessionId, driveData) {
  const recording = await Recording.findOne({ sessionId });
  if (!recording) throw new Error('Recording not found');
  recording.status = RECORDING_STATUS.AVAILABLE;
  recording.available = true;
  recording.driveFileId = driveData.driveFileId || '';
  recording.streamUrl = driveData.streamUrl || '';
  recording.thumbnailUrl = driveData.thumbnail || '';
  recording.durationMinutes = driveData.duration || 0;
  recording.fileSizeBytes = driveData.size || 0;
  recording.uploadedAt = driveData.uploadedAt || new Date();
  recording.processedAt = new Date();
  recording.downloadAllowed = false;
  await recording.save();
  return { success: true, recording };
}

export async function markRecordingFailed(sessionId, reason = '') {
  const recording = await Recording.findOne({ sessionId });
  if (!recording) throw new Error('Recording not found');
  recording.status = RECORDING_STATUS.FAILED;
  recording.errorMessage = reason;
  recording.retryCount += 1;
  recording.lastRetryAt = new Date();
  await recording.save();
  return { success: true, recording };
}

export async function getSecureStreamUrl(sessionId, userId, role, req = null) {
  const recording = await Recording.findOne({ sessionId });
  if (!recording?.available || !recording.driveFileId) throw new Error('Recording not available');
  const session = await ClassSession.findById(sessionId)
    .populate('classGroup', 'students subject grade')
    .populate('teacher', 'fullName');
  if (role === 'student') {
    const isEnrolled = session?.classGroup?.students?.some(s => String(s._id || s) === String(userId));
    if (!isEnrolled) {
      await auditAccess({ sessionId, userId, role, action: 'denied', granted: false, denialReason: 'Not enrolled in this class', session, req });
      throw new Error('Access denied');
    }
  }
  const tokenId = recording.generateToken(1, 2);
  await recording.save();
  await auditAccess({ sessionId, userId, role, action: 'play', granted: true, session, req, urlGenerated: true, urlExpiresAt: recording.token.tokenExpiresAt });
  return { url: recording.streamUrl, token: tokenId, expiresAt: recording.token.tokenExpiresAt, sessionId, subject: session?.classGroup?.subject || '', duration: recording.durationMinutes };
}

// Audit logging is best-effort: a logging failure must never break playback.
async function auditAccess({ sessionId, userId, role, action, granted, denialReason = '', session = null, req = null, urlGenerated = false, urlExpiresAt = null }) {
  try {
    await logAccess({
      sessionId,
      userId,
      role,
      action,
      granted,
      denialReason,
      sessionInfo: {
        subject: session?.classGroup?.subject || '',
        grade: session?.classGroup?.grade || '',
        teacherName: session?.teacher?.fullName || '',
      },
      req,
      urlGenerated,
      urlExpiresAt,
    });
  } catch (err) {
    console.warn('[recording] access log failed:', err.message);
  }
}

/**
 * Record a playback view (POST /api/stream/:sessionId/view-log).
 * Bumps the recording's analytics counters and writes an audit log entry.
 */
export async function logRecordingView(sessionId, userId, req = null, role = 'student') {
  const recording = await Recording.findOne({ sessionId });
  if (!recording) throw new Error('Recording not found');

  // Counters only — a failure here must not break playback.
  try {
    await Recording.updateOne(
      { _id: recording._id },
      { $inc: { 'analytics.totalViews': 1 }, $set: { 'analytics.lastViewedAt': new Date() } }
    );
  } catch (err) {
    console.warn('[recording] view counter failed:', err.message);
  }

  const session = await ClassSession.findById(sessionId)
    .populate('classGroup', 'subject grade')
    .populate('teacher', 'fullName');

  await auditAccess({ sessionId, userId, role, action: 'view', granted: true, session, req });

  return { success: true };
}

export async function detectRecordingForSession(sessionId) {
  const session = await ClassSession.findById(sessionId).populate('classGroup', 'subject').lean();
  if (!session) throw new Error('Session not found');
  const recording = await Recording.findOne({ sessionId });
  if (recording?.status === RECORDING_STATUS.AVAILABLE) return { found: false, reason: 'Already available' };
  // meetingCode lives on the ClassSession (not the class group), and
  // findMeetingRecording() takes positional args (meetingCode, subject).
  const driveRecording = await drive.findMeetingRecording(session.meetingCode, session.classGroup?.subject);
  if (!driveRecording) return { found: false, reason: 'Not found' };
  await markRecordingProcessing(sessionId, driveRecording.id);
  const processed = await drive.processRecording(driveRecording);
  await completeRecordingProcessing(sessionId, processed);
  return { found: true, recording: processed };
}

export async function processPendingRecordings() {
  const pending = await Recording.findPendingProcessing(50);
  const results = [];
  for (const r of pending) {
    try {
      const result = await detectRecordingForSession(r.sessionId.toString());
      results.push({ sessionId: r.sessionId, ...result });
    } catch (err) { results.push({ sessionId: r.sessionId, found: false, error: err.message }); }
  }
  return results;
}

export async function getPendingRecordings(limit = 50) {
  const recordings = await Recording.findPendingProcessing(limit);
  return recordings.map(r => ({ id: r._id, sessionId: r.sessionId, status: r.status, retryCount: r.retryCount }));
}

export default { initializeRecording, markRecordingProcessing, completeRecordingProcessing, markRecordingFailed, getSecureStreamUrl, logRecordingView, detectRecordingForSession, processPendingRecordings, getPendingRecordings, RECORDING_STATUS };
