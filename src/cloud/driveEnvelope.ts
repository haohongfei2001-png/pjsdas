import type { PJSDASSnapshot } from '../snapshot.js'

export const DRIVE_WORKSPACE_SCHEMA = 'pjsdas-google-drive-workspace' as const
export const DRIVE_WORKSPACE_ENVELOPE_VERSION = 1 as const
export const DRIVE_WORKSPACE_FILENAME = 'pjsdas-workspace.json'

export interface DriveWorkspaceEnvelope {
  schema: typeof DRIVE_WORKSPACE_SCHEMA
  version: typeof DRIVE_WORKSPACE_ENVELOPE_VERSION
  fingerprint: string
  updatedByDevice: string
  updatedAt: string
  snapshot: PJSDASSnapshot
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createDriveWorkspaceEnvelope(input: {
  fingerprint: string
  deviceId: string
  snapshot: PJSDASSnapshot
  updatedAt?: string
}): DriveWorkspaceEnvelope {
  return {
    schema: DRIVE_WORKSPACE_SCHEMA,
    version: DRIVE_WORKSPACE_ENVELOPE_VERSION,
    fingerprint: input.fingerprint,
    updatedByDevice: input.deviceId,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    snapshot: input.snapshot,
  }
}

export function parseDriveWorkspaceEnvelope(value: unknown): DriveWorkspaceEnvelope {
  if (!isObject(value)) throw new Error('Google Drive 中的 PJSDAS 工作区格式无效。')
  if (value.schema !== DRIVE_WORKSPACE_SCHEMA || value.version !== DRIVE_WORKSPACE_ENVELOPE_VERSION) {
    throw new Error('Google Drive 中的 PJSDAS 工作区版本不受支持。')
  }
  if (typeof value.fingerprint !== 'string' || !value.fingerprint || typeof value.updatedByDevice !== 'string' || !value.updatedByDevice) {
    throw new Error('Google Drive 工作区缺少同步元数据。')
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(new Date(value.updatedAt).getTime())) {
    throw new Error('Google Drive 工作区更新时间无效。')
  }
  if (!isObject(value.snapshot)) throw new Error('Google Drive 工作区缺少 PJSDAS Snapshot。')
  return value as unknown as DriveWorkspaceEnvelope
}
