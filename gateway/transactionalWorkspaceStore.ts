import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export type MutationPrincipalKind = 'first_party_web' | 'delegated_mcp' | 'automation'

export interface ConnectedWorkspaceRecord {
  workspaceId: string
  userId: string
  snapshot: PJSDASSnapshot
  revision: number
  schemaVersion: number
}

export interface ConnectedCommitInput {
  userId: string
  commandId: string
  operation: string
  payloadHash: string
  expectedRevision: number
  snapshot: PJSDASSnapshot
  schemaVersion: number
  principalKind: MutationPrincipalKind
  clientId?: string
  provenance?: Record<string, unknown>
  compensation?: Record<string, unknown>
  effectiveTime?: string
}

export interface ConnectedCommandRecord {
  commandId: string
  operation: string
  payloadHash: string
  resultingRevision: number
  receipt: Record<string, unknown>
  compensation?: Record<string, unknown>
}

export interface ConnectedCommitResult {
  outcome: 'COMMITTED' | 'ALREADY_APPLIED' | 'CONFLICT'
  workspaceId: string
  revision: number
  snapshot: PJSDASSnapshot
  receipt: Record<string, unknown>
}

export interface TransactionalWorkspaceStoreOptions {
  supabaseUrl: string
  serviceRoleKey: string
  fetchImpl?: typeof fetch
}

function authHeaders(serviceRoleKey: string) {
  return {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    'content-type': 'application/json',
  }
}

function requireServiceRoleKey(value: string) {
  const key = value.trim()
  if (!key) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'PJSDAS transactional workspace service credential is not configured.', false)
  return key
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseWorkspaceRow(row: Record<string, unknown>, userId: string): ConnectedWorkspaceRecord {
  if (row.user_id !== userId || typeof row.id !== 'string' || !validRevision(row.revision) || typeof row.schema_version !== 'number') {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'PJSDAS transactional workspace metadata is invalid.', false)
  }
  validateSnapshot(row.snapshot)
  const snapshot = upgradeSnapshotToLatest(row.snapshot)
  return {
    workspaceId: row.id,
    userId,
    snapshot,
    revision: row.revision,
    schemaVersion: snapshot.version,
  }
}

export function createTransactionalWorkspaceStore(options: TransactionalWorkspaceStoreOptions) {
  const baseUrl = options.supabaseUrl.replace(/\/+$/, '')
  const serviceRoleKey = requireServiceRoleKey(options.serviceRoleKey)
  const fetchImpl = options.fetchImpl ?? fetch

  async function request(path: string, init: RequestInit = {}) {
    let response: Response
    try {
      const headers = new Headers(init.headers)
      for (const [name, value] of Object.entries(authHeaders(serviceRoleKey))) headers.set(name, value)
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers,
      })
    } catch {
      throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', 'PJSDAS transactional workspace is temporarily unavailable.', true)
    }
    return response
  }

  return {
    async readForUser(userId: string): Promise<ConnectedWorkspaceRecord | null> {
      const params = new URLSearchParams({
        select: 'id,user_id,snapshot,revision,schema_version',
        user_id: `eq.${userId}`,
        limit: '1',
      })
      const response = await request(`/rest/v1/pjsdas_workspaces?${params.toString()}`, { method: 'GET' })
      if (!response.ok) {
        throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `PJSDAS workspace read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      }
      const rows = await response.json().catch(() => undefined) as Record<string, unknown>[] | undefined
      if (!rows) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'PJSDAS workspace read returned invalid JSON.', false)
      return rows[0] ? parseWorkspaceRow(rows[0], userId) : null
    },

    async readCommandForUser(userId: string, commandId: string): Promise<ConnectedCommandRecord | null> {
      const params = new URLSearchParams({
        select: 'command_id,operation,payload_hash,resulting_revision,receipt,compensation,status',
        user_id: `eq.${userId}`,
        command_id: `eq.${commandId}`,
        status: 'eq.COMMITTED',
        limit: '1',
      })
      const response = await request(`/rest/v1/pjsdas_command_ledger?${params.toString()}`, { method: 'GET' })
      if (!response.ok) {
        throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `PJSDAS command receipt read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      }
      const rows = await response.json().catch(() => undefined) as Record<string, unknown>[] | undefined
      const row = rows?.[0]
      if (!row) return null
      if (
        typeof row.command_id !== 'string'
        || typeof row.operation !== 'string'
        || typeof row.payload_hash !== 'string'
        || !validRevision(row.resulting_revision)
      ) {
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'PJSDAS command receipt metadata is invalid.', false)
      }
      return {
        commandId: row.command_id,
        operation: row.operation,
        payloadHash: row.payload_hash,
        resultingRevision: row.resulting_revision,
        receipt: typeof row.receipt === 'object' && row.receipt !== null ? row.receipt as Record<string, unknown> : {},
        compensation: typeof row.compensation === 'object' && row.compensation !== null ? row.compensation as Record<string, unknown> : undefined,
      }
    },

    async bootstrapForUser(input: {
      userId: string
      snapshot: PJSDASSnapshot
      schemaVersion: number
      sourceFingerprint?: string
      migratedFrom?: string
    }): Promise<ConnectedWorkspaceRecord> {
      validateSnapshot(input.snapshot)
      const snapshot = upgradeSnapshotToLatest(input.snapshot)
      const response = await request('/rest/v1/rpc/pjsdas_bootstrap_workspace', {
        method: 'POST',
        body: JSON.stringify({
          target_user_id: input.userId,
          initial_snapshot: snapshot,
          initial_schema_version: snapshot.version,
          initial_source_fingerprint: input.sourceFingerprint ?? null,
          initial_migrated_from: input.migratedFrom ?? null,
        }),
      })
      if (!response.ok) {
        throw new WorkspaceSourceError('WORKSPACE_MIGRATION_FAILED', `PJSDAS workspace bootstrap failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      }
      const rows = await response.json().catch(() => undefined) as Array<Record<string, unknown>> | undefined
      const row = rows?.[0]
      if (!row || typeof row.workspace_id !== 'string' || !validRevision(row.revision)) {
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'PJSDAS workspace bootstrap returned invalid metadata.', false)
      }
      validateSnapshot(row.snapshot)
      return {
        workspaceId: row.workspace_id,
        userId: input.userId,
        snapshot: row.snapshot,
        revision: row.revision,
        schemaVersion: snapshot.version,
      }
    },

    async commitForUser(input: ConnectedCommitInput): Promise<ConnectedCommitResult> {
      validateSnapshot(input.snapshot)
      const snapshot = upgradeSnapshotToLatest(input.snapshot)
      const response = await request('/rest/v1/rpc/pjsdas_commit_workspace', {
        method: 'POST',
        body: JSON.stringify({
          target_user_id: input.userId,
          target_command_id: input.commandId,
          target_operation: input.operation,
          target_payload_hash: input.payloadHash,
          target_expected_revision: input.expectedRevision,
          target_snapshot: snapshot,
          target_schema_version: snapshot.version,
          target_principal_kind: input.principalKind,
          target_client_id: input.clientId ?? null,
          target_provenance: input.provenance ?? {},
          target_compensation: input.compensation ?? null,
          target_effective_time: input.effectiveTime ?? null,
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string; details?: string }
        const duplicateCommand = response.status === 409 || body.message?.includes('different payload') || body.details?.includes('different payload')
        throw new WorkspaceSourceError(
          duplicateCommand ? 'COMMAND_ID_REUSED' : 'WORKSPACE_COMMIT_FAILED',
          duplicateCommand ? 'PJSDAS command id was reused with a different payload.' : `PJSDAS workspace commit failed (HTTP ${response.status}).`,
          !duplicateCommand && (response.status >= 500 || response.status === 429),
        )
      }

      const rows = await response.json().catch(() => undefined) as Array<Record<string, unknown>> | undefined
      const row = rows?.[0]
      if (
        !row
        || !['COMMITTED', 'ALREADY_APPLIED', 'CONFLICT'].includes(String(row.outcome))
        || typeof row.workspace_id !== 'string'
        || !validRevision(row.revision)
      ) {
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'PJSDAS commit returned invalid metadata.', false)
      }
      validateSnapshot(row.snapshot)
      return {
        outcome: row.outcome as ConnectedCommitResult['outcome'],
        workspaceId: row.workspace_id,
        revision: row.revision,
        snapshot: row.snapshot,
        receipt: typeof row.receipt === 'object' && row.receipt !== null ? row.receipt as Record<string, unknown> : {},
      }
    },
  }
}
