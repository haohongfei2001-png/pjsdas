import type { BridgeReadContext } from '../src/ai/readLayer.js'
import {
  DRIVE_WORKSPACE_FILENAME,
  createDriveWorkspaceEnvelope,
  parseDriveWorkspaceEnvelope,
} from '../src/cloud/driveEnvelope.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { validateSnapshot } from '../src/snapshot.js'
import {
  WorkspaceSourceError,
  type GatewayWorkspace,
  type WorkspaceSource,
  type WorkspaceWriteInput,
} from './workspaceSource.js'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const METADATA_FIELDS = 'id,name,version,modifiedTime'

interface DriveFileMetadata {
  id?: string
  name?: string
  version?: string | number
  modifiedTime?: string
}

interface DriveFileList {
  files?: DriveFileMetadata[]
}

export interface DriveWorkspaceSourceOptions {
  getAccessToken: () => string | Promise<string>
  fetchImpl?: typeof fetch
  timezone?: string
  now?: () => Date
  defaultAvailableMinutes?: number
}

function validateToken(token: string) {
  const value = token.trim()
  if (!value || /[\r\n]/.test(value)) {
    throw new WorkspaceSourceError(
      'GOOGLE_AUTH_REQUIRED',
      'PJSDAS needs a valid Google authorization before it can read the workspace.',
      false,
    )
  }
  return value
}

function validateAvailableMinutes(value: number | undefined) {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 30 || value > 1440) {
    throw new WorkspaceSourceError(
      'INVALID_SOURCE_CONFIG',
      'defaultAvailableMinutes must be between 30 and 1440.',
      false,
    )
  }
  return value
}

function validateNow(now: Date) {
  if (Number.isNaN(now.getTime())) {
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Drive workspace source returned an invalid current time.', false)
  }
  return now
}

async function driveRequest(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetchImpl(url, { ...init, headers })
  } catch {
    throw new WorkspaceSourceError(
      'GOOGLE_DRIVE_UNAVAILABLE',
      'Google Drive could not be reached. Try again later.',
      true,
    )
  }

  if (response.ok) return response

  if (response.status === 401) {
    throw new WorkspaceSourceError(
      'GOOGLE_AUTH_EXPIRED',
      'Google authorization is no longer valid. Reconnect Google Drive to PJSDAS.',
      false,
    )
  }

  if (response.status === 403) {
    throw new WorkspaceSourceError(
      'GOOGLE_AUTH_FORBIDDEN',
      'Google Drive denied access to the PJSDAS app-data workspace.',
      false,
    )
  }

  if (response.status === 429 || response.status >= 500) {
    throw new WorkspaceSourceError(
      'GOOGLE_DRIVE_UNAVAILABLE',
      `Google Drive is temporarily unavailable (HTTP ${response.status}).`,
      true,
    )
  }

  throw new WorkspaceSourceError(
    'GOOGLE_DRIVE_REQUEST_FAILED',
    `Google Drive request failed (HTTP ${response.status}).`,
    false,
  )
}

async function listWorkspaceFiles(fetchImpl: typeof fetch, token: string) {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${DRIVE_WORKSPACE_FILENAME}' and trashed = false`,
    fields: `files(${METADATA_FIELDS})`,
    pageSize: '10',
    orderBy: 'modifiedTime desc',
  })
  const response = await driveRequest(fetchImpl, token, `${DRIVE_API}/files?${params.toString()}`)

  let data: DriveFileList
  try {
    data = await response.json() as DriveFileList
  } catch {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Google Drive returned invalid workspace metadata.', false)
  }

  const files = data.files ?? []
  if (files.length === 0) {
    throw new WorkspaceSourceError(
      'WORKSPACE_NOT_FOUND',
      'No PJSDAS workspace exists in this Google Drive app-data folder yet.',
      false,
    )
  }
  if (files.length > 1) {
    throw new WorkspaceSourceError(
      'WORKSPACE_DUPLICATE',
      'Multiple PJSDAS workspace files exist in Google Drive appDataFolder. Reading stopped to avoid selecting the wrong workspace.',
      false,
    )
  }
  return files[0]!
}

async function metadataForFile(fetchImpl: typeof fetch, token: string, fileId: string) {
  const params = new URLSearchParams({ fields: METADATA_FIELDS })
  const response = await driveRequest(
    fetchImpl,
    token,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
  )

  let data: DriveFileMetadata
  try {
    data = await response.json() as DriveFileMetadata
  } catch {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Google Drive returned invalid workspace metadata.', false)
  }

  if (!data.id || data.version === undefined || !data.modifiedTime) {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Google Drive workspace metadata is incomplete.', false)
  }

  return {
    id: data.id,
    version: String(data.version),
    modifiedTime: data.modifiedTime,
  }
}

async function resolveMetadata(fetchImpl: typeof fetch, token: string, file: DriveFileMetadata) {
  if (!file.id) {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Google Drive workspace metadata is missing a file id.', false)
  }
  if (file.version !== undefined && file.modifiedTime) {
    return {
      id: file.id,
      version: String(file.version),
      modifiedTime: file.modifiedTime,
    }
  }
  return metadataForFile(fetchImpl, token, file.id)
}

async function downloadAndVerifyWorkspace(fetchImpl: typeof fetch, token: string, fileId: string) {
  const response = await driveRequest(
    fetchImpl,
    token,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
  )

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Google Drive returned malformed PJSDAS workspace JSON.', false)
  }

  let envelope
  try {
    envelope = parseDriveWorkspaceEnvelope(raw)
    validateSnapshot(envelope.snapshot)
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'PJSDAS workspace validation failed.'
    throw new WorkspaceSourceError('WORKSPACE_INVALID', message, false)
  }

  const fingerprint = await fingerprintWorkspace(envelope.snapshot)
  if (fingerprint !== envelope.fingerprint) {
    throw new WorkspaceSourceError(
      'WORKSPACE_INVALID',
      'Google Drive workspace fingerprint verification failed. PJSDAS will not expose this data to AI.',
      false,
    )
  }

  return envelope
}

function workspaceContext(
  metadataVersion: string,
  nowProvider: () => Date,
  timezone: string,
  defaultAvailableMinutes: number | undefined,
): BridgeReadContext {
  return {
    now: validateNow(nowProvider()),
    timezone,
    workspaceVersion: `drive:${metadataVersion}`,
    defaultAvailableMinutes,
  }
}

export function createDriveWorkspaceSource(options: DriveWorkspaceSourceOptions): WorkspaceSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const defaultAvailableMinutes = validateAvailableMinutes(options.defaultAvailableMinutes)
  const timezone = options.timezone?.trim() || 'UTC'
  const nowProvider = options.now ?? (() => new Date())

  return {
    async read(): Promise<GatewayWorkspace> {
      const token = validateToken(await options.getAccessToken())
      const file = await listWorkspaceFiles(fetchImpl, token)
      const metadata = await resolveMetadata(fetchImpl, token, file)
      const envelope = await downloadAndVerifyWorkspace(fetchImpl, token, metadata.id)

      return {
        snapshot: envelope.snapshot,
        context: workspaceContext(metadata.version, nowProvider, timezone, defaultAvailableMinutes),
      }
    },

    async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
      validateSnapshot(input.snapshot)
      const token = validateToken(await options.getAccessToken())
      const file = await listWorkspaceFiles(fetchImpl, token)
      const metadata = await resolveMetadata(fetchImpl, token, file)
      const actualVersion = `drive:${metadata.version}`
      if (input.expectedWorkspaceVersion && input.expectedWorkspaceVersion !== actualVersion) {
        throw new WorkspaceSourceError(
          'WORKSPACE_CONFLICT',
          `PJSDAS workspace changed since the ingestion baseline (${input.expectedWorkspaceVersion} → ${actualVersion}). Retry from the latest workspace instead of overwriting it.`,
          true,
        )
      }

      // Check again immediately before upload. This mirrors the browser sync's
      // fail-closed optimistic baseline and prevents the common stale-writer case.
      const beforeUpload = await metadataForFile(fetchImpl, token, metadata.id)
      const beforeUploadVersion = `drive:${beforeUpload.version}`
      if (input.expectedWorkspaceVersion && input.expectedWorkspaceVersion !== beforeUploadVersion) {
        throw new WorkspaceSourceError(
          'WORKSPACE_CONFLICT',
          `PJSDAS workspace changed while preparing ingestion (${input.expectedWorkspaceVersion} → ${beforeUploadVersion}).`,
          true,
        )
      }

      const fingerprint = await fingerprintWorkspace(input.snapshot)
      const envelope = createDriveWorkspaceEnvelope({
        fingerprint,
        snapshot: input.snapshot,
        deviceId: input.updatedByDevice?.trim() || 'gateway-autonomous-ingestion',
      })
      const params = new URLSearchParams({ uploadType: 'media', fields: METADATA_FIELDS })
      const response = await driveRequest(
        fetchImpl,
        token,
        `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(metadata.id)}?${params.toString()}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify(envelope),
        },
      )

      let updated: DriveFileMetadata
      try {
        updated = await response.json() as DriveFileMetadata
      } catch {
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Google Drive returned invalid metadata after workspace update.', false)
      }
      if (!updated.id || updated.version === undefined || !updated.modifiedTime) {
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Google Drive returned incomplete metadata after workspace update.', false)
      }

      return {
        snapshot: input.snapshot,
        context: workspaceContext(String(updated.version), nowProvider, timezone, defaultAvailableMinutes),
      }
    },
  }
}
