import { fetchBackend } from '../backendEndpoints.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import { fingerprintWorkspace } from './workspaceFingerprint.js'
import { getAccountAccessToken } from './cloudClient.js'

export interface ConnectedRemoteWorkspaceRow {
  fileId: string
  version: string
  schemaVersion: number
  fingerprint: string
  snapshot: PJSDASSnapshot
  updatedByDevice: string
  updatedAt: string
}

export function connectedWorkspaceAuthorityEnabled() {
  const env = import.meta.env as Record<string, string | undefined>
  return env.VITE_PJSDAS_CONNECTED_AUTHORITY?.trim() === 'transactional'
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${await getAccountAccessToken()}`)
  if (init.body) headers.set('content-type', 'application/json')
  return fetchBackend(path, { ...init, headers })
}

async function parseWorkspaceResponse(response: Response): Promise<ConnectedRemoteWorkspaceRow> {
  const body = await response.json().catch(() => undefined) as {
    workspaceId?: string
    workspaceVersion?: string
    revision?: number
    schemaVersion?: number
    snapshot?: unknown
    code?: string
    message?: string
  } | undefined
  if (!response.ok) {
    const code = body?.code ?? 'CONNECTED_WORKSPACE_FAILED'
    throw new Error(`${code}: ${body?.message ?? `HTTP ${response.status}`}`)
  }
  if (!body?.workspaceId || !Number.isInteger(body.revision) || typeof body.schemaVersion !== 'number') {
    throw new Error('CONNECTED_WORKSPACE_INVALID: server metadata is incomplete.')
  }
  validateSnapshot(body.snapshot)
  const snapshot = body.snapshot as PJSDASSnapshot
  const fingerprint = await fingerprintWorkspace(snapshot)
  return {
    fileId: body.workspaceId,
    version: body.workspaceVersion ?? `txn:${body.revision}`,
    schemaVersion: body.schemaVersion,
    fingerprint,
    snapshot,
    updatedByDevice: 'transactional-server',
    updatedAt: new Date().toISOString(),
  }
}

export async function fetchConnectedRemoteWorkspace(): Promise<ConnectedRemoteWorkspaceRow> {
  return parseWorkspaceResponse(await request('/api/workspace', {
    method: 'POST',
    body: JSON.stringify({ action: 'read' }),
  }))
}

export async function createConnectedRemoteWorkspace(): Promise<never> {
  throw new Error('WORKSPACE_MIGRATION_REQUIRED: connected mode requires an explicit migration before normal sync can create authoritative state.')
}

export async function updateConnectedRemoteWorkspace(input: {
  expectedVersion: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<ConnectedRemoteWorkspaceRow | null> {
  const match = /^txn:(\d+)$/.exec(input.expectedVersion)
  if (!match) throw new Error(`WORKSPACE_CONFLICT: invalid transactional workspace version ${input.expectedVersion}.`)
  const response = await request('/api/workspace', {
    method: 'POST',
    body: JSON.stringify({
      action: 'commit',
      commandId: `web-sync:${input.deviceId}:${match[1]}:${input.fingerprint}`,
      expectedRevision: Number(match[1]),
      snapshot: input.snapshot,
    }),
  })
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => undefined) as { outcome?: string; code?: string } | undefined
    if (body?.outcome === 'CONFLICT') return null
  }
  return parseWorkspaceResponse(response)
}

export async function bootstrapConnectedWorkspace(input: {
  snapshot: PJSDASSnapshot
  sourceFingerprint?: string
  migratedFrom: 'local' | 'drive' | 'reconciled'
}) {
  validateSnapshot(input.snapshot)
  return parseWorkspaceResponse(await request('/api/workspace', {
    method: 'POST',
    body: JSON.stringify({
      action: 'bootstrap',
      confirmMigration: true,
      snapshot: input.snapshot,
      sourceFingerprint: input.sourceFingerprint,
      migratedFrom: input.migratedFrom,
    }),
  }))
}
