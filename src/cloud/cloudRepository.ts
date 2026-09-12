import type { PJSDASSnapshot } from '../snapshot.js'
import { getCloudAccessToken, invalidateCloudSession } from './cloudClient.js'
import {
  DRIVE_WORKSPACE_FILENAME,
  createDriveWorkspaceEnvelope,
  parseDriveWorkspaceEnvelope,
} from './driveEnvelope.js'

export interface RemoteWorkspaceRow {
  fileId: string
  version: string
  schemaVersion: number
  fingerprint: string
  snapshot: PJSDASSnapshot
  updatedByDevice: string
  updatedAt: string
}

type DriveFileMetadata = {
  id?: string
  name?: string
  version?: string | number
  modifiedTime?: string
}

type DriveFileList = {
  files?: DriveFileMetadata[]
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const metadataFields = 'id,name,version,modifiedTime'

async function errorMessage(response: Response) {
  try {
    const data = await response.json() as { error?: { message?: string } }
    return data.error?.message || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

async function driveFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${await getCloudAccessToken()}`)
  const response = await fetch(url, { ...init, headers })
  if (response.status === 401) {
    invalidateCloudSession()
    throw new Error('Google Drive 短期授权已失效，PJSDAS 会在下次同步时自动重新获取。')
  }
  if (!response.ok) throw new Error(`Google Drive 请求失败：${await errorMessage(response)}`)
  return response
}

async function listWorkspaceFiles() {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${DRIVE_WORKSPACE_FILENAME}' and trashed = false`,
    fields: `files(${metadataFields})`,
    pageSize: '10',
    orderBy: 'modifiedTime desc',
  })
  const response = await driveFetch(`${DRIVE_API}/files?${params.toString()}`)
  const data = await response.json() as DriveFileList
  const files = data.files ?? []
  if (files.length > 1) {
    throw new Error('Google Drive 的 PJSDAS 隐藏目录中出现了多个工作区文件。为避免覆盖错误数据，同步已停止。')
  }
  return files
}

async function metadataForFile(fileId: string) {
  const params = new URLSearchParams({ fields: metadataFields })
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`)
  const data = await response.json() as DriveFileMetadata
  if (!data.id || data.version === undefined || !data.modifiedTime) throw new Error('Google Drive 返回的工作区元数据不完整。')
  return {
    id: data.id,
    version: String(data.version),
    modifiedTime: data.modifiedTime,
  }
}

async function downloadEnvelope(fileId: string) {
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`)
  return parseDriveWorkspaceEnvelope(await response.json())
}

export async function fetchRemoteWorkspace(_userId: string): Promise<RemoteWorkspaceRow | null> {
  const files = await listWorkspaceFiles()
  const file = files[0]
  if (!file?.id) return null
  const meta = file.version !== undefined && file.modifiedTime
    ? { id: file.id, version: String(file.version), modifiedTime: file.modifiedTime }
    : await metadataForFile(file.id)
  const envelope = await downloadEnvelope(file.id)
  return {
    fileId: meta.id,
    version: meta.version,
    schemaVersion: envelope.version,
    fingerprint: envelope.fingerprint,
    snapshot: envelope.snapshot,
    updatedByDevice: envelope.updatedByDevice,
    updatedAt: meta.modifiedTime || envelope.updatedAt,
  }
}

export async function createRemoteWorkspace(input: {
  userId: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  void input.userId
  if ((await listWorkspaceFiles()).length > 0) return null
  const envelope = createDriveWorkspaceEnvelope({
    fingerprint: input.fingerprint,
    snapshot: input.snapshot,
    deviceId: input.deviceId,
  })
  const boundary = `pjsdas-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
  const metadata = JSON.stringify({
    name: DRIVE_WORKSPACE_FILENAME,
    mimeType: 'application/json',
    parents: ['appDataFolder'],
    appProperties: { pjsdasWorkspace: 'v1' },
  })
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(envelope),
    `--${boundary}--`,
    '',
  ].join('\r\n')
  const params = new URLSearchParams({ uploadType: 'multipart', fields: metadataFields })
  const response = await driveFetch(`${DRIVE_UPLOAD_API}/files?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  const meta = await response.json() as DriveFileMetadata
  if (!meta.id || meta.version === undefined || !meta.modifiedTime) throw new Error('Google Drive 创建工作区后未返回完整元数据。')
  return {
    fileId: meta.id,
    version: String(meta.version),
    schemaVersion: envelope.version,
    fingerprint: envelope.fingerprint,
    snapshot: envelope.snapshot,
    updatedByDevice: envelope.updatedByDevice,
    updatedAt: meta.modifiedTime,
  }
}

export async function updateRemoteWorkspace(input: {
  userId: string
  fileId: string
  expectedVersion: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  void input.userId
  const before = await metadataForFile(input.fileId)
  if (before.version !== input.expectedVersion) return null

  const envelope = createDriveWorkspaceEnvelope({
    fingerprint: input.fingerprint,
    snapshot: input.snapshot,
    deviceId: input.deviceId,
  })
  const params = new URLSearchParams({ uploadType: 'media', fields: metadataFields })
  const response = await driveFetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(input.fileId)}?${params.toString()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(envelope),
  })
  const meta = await response.json() as DriveFileMetadata
  if (!meta.id || meta.version === undefined || !meta.modifiedTime) throw new Error('Google Drive 更新工作区后未返回完整元数据。')
  return {
    fileId: meta.id,
    version: String(meta.version),
    schemaVersion: envelope.version,
    fingerprint: envelope.fingerprint,
    snapshot: envelope.snapshot,
    updatedByDevice: envelope.updatedByDevice,
    updatedAt: meta.modifiedTime,
  }
}
