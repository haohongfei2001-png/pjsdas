import { fetchBackend } from '../backendEndpoints.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import { fingerprintWorkspace } from './workspaceFingerprint.js'
import { getAccountAccessToken } from './cloudClient.js'
import { AccountCacheChangedError, currentAccountCacheGeneration } from './accountCacheLease.js'

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

async function request(path: string, init: RequestInit = {}, accountKey?: string) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${await getAccountAccessToken(accountKey)}`)
  if (init.body) headers.set('content-type', 'application/json')
  return fetchBackend(path, { ...init, headers })
}

async function parseWorkspaceResponse(response: Response, assertReadCurrent?: () => void): Promise<ConnectedRemoteWorkspaceRow> {
  assertReadCurrent?.()
  const body = await response.json().catch(() => undefined) as {
    workspaceId?: string
    workspaceVersion?: string
    revision?: number
    schemaVersion?: number
    snapshot?: unknown
    code?: string
    message?: string
  } | undefined
  assertReadCurrent?.()
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

type InFlightRead = { serial: number; active: number; current?: Promise<ConnectedRemoteWorkspaceRow> }
const workspaceReads = new Map<string, InFlightRead>()
let readSerial = 0
export async function fetchConnectedRemoteWorkspace(accountKey?: string, assertReadCurrent?: () => void, options: { passive?: boolean } = {}): Promise<ConnectedRemoteWorkspaceRow> {
  assertReadCurrent?.()
  const generation = currentAccountCacheGeneration(), token = await getAccountAccessToken(accountKey)
  if (currentAccountCacheGeneration() !== generation) throw new AccountCacheChangedError()
  assertReadCurrent?.()
  // Tokens are used only in this short-lived in-memory map; never persisted or
  // logged. Same-user sessions cannot borrow each other's authenticated read.
  const key = JSON.stringify([accountKey ?? '', token, generation])
  let entry = workspaceReads.get(key)
  if (!entry) { entry = { serial: 0, active: 0 }; workspaceReads.set(key, entry) }
  let reading = options.passive ? entry.current : undefined
  let serial = entry.serial
  if (!reading) {
    serial = ++readSerial; entry.serial = serial; entry.active += 1
    const owner = entry
    const pending = fetchBackend('/api/workspace', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'read' }) })
      .then(response => parseWorkspaceResponse(response))
      .then(async result => {
        // Keep the read in flight through the last asynchronous session check.
        // A newer forced read admitted during that check invalidates this one.
        const currentToken = await getAccountAccessToken(accountKey)
        if (owner.serial !== serial || currentAccountCacheGeneration() !== generation || currentToken !== token) throw new AccountCacheChangedError()
        return result
      })
    reading = pending.finally(() => {
      owner.active -= 1
      // An older finally must not erase a newer forced read or return an old
      // resolved result to a later passive refresh.
      if (owner.current === reading) owner.current = undefined
      if (owner.active === 0 && workspaceReads.get(key) === owner) workspaceReads.delete(key)
    })
    owner.current = reading
  }
  const result = await reading
  assertReadCurrent?.()
  if (entry.serial !== serial || currentAccountCacheGeneration() !== generation || workspaceReads.has(key) && workspaceReads.get(key) !== entry) throw new AccountCacheChangedError()
  assertReadCurrent?.()
  return structuredClone(result)
}

export async function createConnectedRemoteWorkspace(): Promise<never> {
  throw new Error('WORKSPACE_MIGRATION_REQUIRED: connected mode requires an explicit migration before normal sync can create authoritative state.')
}

export async function updateConnectedRemoteWorkspace(input: {
  accountKey?: string
  expectedVersion: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
  purpose: 'migration_recovery'
}): Promise<ConnectedRemoteWorkspaceRow | null> {
  const match = /^txn:(\d+)$/.exec(input.expectedVersion)
  if (!match) throw new Error(`WORKSPACE_CONFLICT: invalid transactional workspace version ${input.expectedVersion}.`)
  const response = await request('/api/workspace', {
    method: 'POST',
    body: JSON.stringify({
      action: 'commit',
      commandId: `web-sync:${input.deviceId}:${match[1]}:${input.fingerprint}`,
      expectedRevision: Number(match[1]),
      snapshotPurpose: input.purpose,
      snapshot: input.snapshot,
    }),
  }, input.accountKey)
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
