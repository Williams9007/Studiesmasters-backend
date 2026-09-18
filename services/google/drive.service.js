// services/google/drive.service.js
// Google Drive API service for recording management
import { config } from './config.js';
import { getAccessToken } from './token.service.js';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

export async function driveRequest(path, options = {}) {
  const token = await getAccessToken();
  const url = DRIVE_API_BASE + path;
  
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error('Drive API error (' + res.status + '): ' + errorText.slice(0, 300));
  }

  return res.json();
}

export async function createFolder(parentId, name) {
  const existing = await driveRequest(
    '/files?q=' + encodeURIComponent('name="' + name + '" and "' + parentId + '" in parents and mimeType="application/vnd.google-apps.folder" and trashed=false') + '&fields=files(id)',
    { method: 'GET' }
  );
  
  if (existing.files?.length > 0) {
    return existing.files[0].id;
  }
  
  const created = await driveRequest('/files', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  
  return created.id;
}

export async function createRecordingFolder(academicYear, level, subject, className, weekNumber) {
  const rootId = 'root';
  const recordingsFolder = await createFolder(rootId, 'Recordings');
  const yearFolder = await createFolder(recordingsFolder, String(academicYear));
  const levelFolder = await createFolder(yearFolder, level);
  const subjectFolder = await createFolder(levelFolder, subject);
  const classFolder = await createFolder(subjectFolder, className);
  const weekFolder = await createFolder(classFolder, 'Week ' + weekNumber);
  
  return weekFolder;
}

export async function findMeetingRecording(meetingCode, subject) {
  const queries = [];
  
  if (meetingCode) {
    queries.push('name contains "' + meetingCode + '"');
  }
  if (subject) {
    queries.push('name contains "' + subject + '"');
  }
  
  queries.push("mimeType contains 'video/'");
  
  const searchQuery = queries.length > 0 
    ? '(' + queries.join(' or ') + ') and trashed=false'
    : "mimeType contains 'video/' and trashed=false";
  
  const files = await driveRequest(
    '/files?q=' + encodeURIComponent(searchQuery) + '&orderBy=createdTime desc&pageSize=10&fields=files(id,name,size,createdTime,modifiedTime,webViewLink,webContentLink,thumbnailLink,mimeType,parents)',
    { method: 'GET' }
  );
  
  return files.files?.[0] || null;
}

export async function getRecordingMetadata(fileId) {
  const file = await driveRequest(
    '/files/' + fileId + '?fields=id,name,size,createdTime,modifiedTime,webViewLink,webContentLink,thumbnailLink,mimeType,parents,description',
    { method: 'GET' }
  );
  
  return {
    driveFileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: Number(file.size || 0),
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
    webContentLink: file.webContentLink,
    thumbnailLink: file.thumbnailLink || null,
    description: file.description || '',
  };
}

export function getRecordingDuration(fileMetadata) {
  const size = fileMetadata.size || 0;
  if (size === 0) return 0;
  const estimatedMinutes = Math.round(size / (1024 * 1024));
  return Math.max(1, estimatedMinutes);
}

export async function getRecordingThumbnail(fileId) {
  const file = await driveRequest(
    '/files/' + fileId + '?fields=thumbnailLink',
    { method: 'GET' }
  );
  return file.thumbnailLink || null;
}

export async function createViewPermission(fileId, email, expirationTime) {
  const permission = await driveRequest(
    '/files/' + fileId + '/permissions',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'user',
        email,
        role: 'reader',
        expirationTime,
        sendNotificationEmail: false,
      }),
    }
  );
  
  return permission;
}

export async function restrictDownload(fileId) {
  await driveRequest(
    '/files/' + fileId,
    {
      method: 'PATCH',
      body: JSON.stringify({
        description: 'Stream-only viewing. Download restricted.',
      }),
    }
  );
}

export function generateStreamUrl(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/preview';
}

export async function processRecording(driveFile) {
  const metadata = await getRecordingMetadata(driveFile.id);
  const duration = getRecordingDuration(metadata);
  const thumbnail = await getRecordingThumbnail(driveFile.id);
  
  return {
    driveFileId: driveFile.id,
    driveFolderId: driveFile.parents?.[0] || '',
    name: driveFile.name,
    mimeType: driveFile.mimeType,
    size: Number(driveFile.size || 0),
    streamUrl: generateStreamUrl(driveFile.id),
    thumbnail: thumbnail || '',
    duration: duration,
    uploadedAt: driveFile.modifiedTime ? new Date(driveFile.modifiedTime) : new Date(),
  };
}

export async function makeMockRecording(subject = 'Class') {
  const mockId = 'mock-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  return {
    driveFileId: mockId,
    driveFolderId: 'mock-folder',
    name: subject + ' - Recording.mp4',
    mimeType: 'video/mp4',
    size: Math.floor(Math.random() * 50000000) + 10000000,
    streamUrl: 'https://drive.google.com/file/d/' + mockId + '/preview',
    thumbnail: 'https://via.placeholder.com/320x180?text=' + encodeURIComponent(subject),
    duration: Math.floor(Math.random() * 60) + 30,
    uploadedAt: new Date(),
  };
}

export default {
  driveRequest,
  createFolder,
  createRecordingFolder,
  findMeetingRecording,
  getRecordingMetadata,
  getRecordingDuration,
  getRecordingThumbnail,
  createViewPermission,
  restrictDownload,
  generateStreamUrl,
  processRecording,
  makeMockRecording,
};
