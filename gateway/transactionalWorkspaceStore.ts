import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { WorkspaceSourceError, type DiscoveryCommitAuthorization } from './workspaceSource.js'
import { discoveryScopeBatchSchema, type DiscoveryScopeLedgerRecord } from '../src/discoveryScopeBatch.js'

export type MutationPrincipalKind = 'first_party_web' | 'delegated_mcp' | 'automation'

export interface ConnectedWorkspaceRecord {
  workspaceId: string
  userId: string
  snapshot: PJSDASSnapshot
  revision: number
  schemaVersion: number
  storedSchemaVersion?: number
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

export interface ConnectedAuthoritativeCommitInput extends ConnectedCommitInput {
  discoveryAuthorization?: DiscoveryCommitAuthorization
  managementAuthorization?: { grantId: string; grantRevision: number; consentVersion?: 2 | 3 | 4 | 5 | 6 | 7 }
  receiptContext: Record<string, unknown>
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
  if (!key) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'TodayAction transactional workspace service credential is not configured.', false)
  return key
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseWorkspaceRow(row: Record<string, unknown>, userId: string, preserveRawData = false, includeStoredSchema = false): ConnectedWorkspaceRecord {
  if (row.user_id !== userId || typeof row.id !== 'string' || !validRevision(row.revision) || typeof row.schema_version !== 'number') {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction transactional workspace metadata is invalid.', false)
  }
  validateSnapshot(row.snapshot)
  const snapshot = preserveRawData ? structuredClone(row.snapshot as PJSDASSnapshot) : upgradeSnapshotToLatest(row.snapshot)
  return {
    workspaceId: row.id,
    userId,
    snapshot,
    revision: row.revision,
    schemaVersion: snapshot.version,
    ...(includeStoredSchema ? { storedSchemaVersion: row.schema_version } : {}),
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
      throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', 'TodayAction transactional workspace is temporarily unavailable.', true)
    }
    return response
  }

  return {
    async readIdentityForUser(userId: string): Promise<Omit<ConnectedWorkspaceRecord, 'snapshot' | 'storedSchemaVersion'> | null> {
      const params = new URLSearchParams({ select: 'id,user_id,revision,schema_version', user_id: `eq.${userId}`, limit: '1' })
      const response = await request(`/rest/v1/pjsdas_workspaces?${params}`, { method: 'GET' })
      if (!response.ok) throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `TodayAction workspace identity read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      const rows: unknown = await response.json().catch(() => undefined)
      if (!Array.isArray(rows) || rows.length > 1) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Workspace identity response is invalid.', false)
      if (!rows.length) return null
      const row = rows[0]
      if (!row || typeof row.id !== 'string' || row.user_id !== userId || !validRevision(row.revision) || typeof row.schema_version !== 'number') throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Workspace identity metadata is invalid.', false)
      return { workspaceId: row.id, userId, revision: row.revision, schemaVersion: row.schema_version }
    },

    async readForUser(userId: string, readOptions?: { preserveRawData?: boolean; includeStoredSchema?: boolean }): Promise<ConnectedWorkspaceRecord | null> {
      const params = new URLSearchParams({
        select: 'id,user_id,snapshot,revision,schema_version',
        user_id: `eq.${userId}`,
        limit: '1',
      })
      const response = await request(`/rest/v1/pjsdas_workspaces?${params.toString()}`, { method: 'GET' })
      if (!response.ok) {
        throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `TodayAction workspace read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      }
      const rows = await response.json().catch(() => undefined) as Record<string, unknown>[] | undefined
      if (!rows) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction workspace read returned invalid JSON.', false)
      return rows[0] ? parseWorkspaceRow(rows[0], userId, readOptions?.preserveRawData, readOptions?.includeStoredSchema) : null
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
        throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `TodayAction command receipt read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
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
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction command receipt metadata is invalid.', false)
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

    async readLatestDiscoveryCommandForUser(userId: string, sourceId: string, scopeFingerprint: string): Promise<(ConnectedCommandRecord & { runId: string; createdAt: string }) | null> {
      if (!userId || !sourceId || sourceId.length > 180 || !/^[a-f0-9]{64}$/.test(scopeFingerprint)) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Invalid Discovery receipt lookup identity.', false)
      const params = new URLSearchParams({
        select: 'user_id,command_id,operation,payload_hash,resulting_revision,receipt,status,provenance,created_at,principal_kind',
        user_id: `eq.${userId}`, operation: 'eq.ingest_verified_discovery', status: 'eq.COMMITTED', principal_kind: 'eq.automation',
        'provenance->>sourceId': `eq.${sourceId}`, 'provenance->>scopeFingerprint': `eq.${scopeFingerprint}`,
        'provenance->>producer': 'eq.server_scheduler', order: 'created_at.desc,resulting_revision.desc', limit: '1',
      })
      const response = await request(`/rest/v1/pjsdas_command_ledger?${params}`, { method: 'GET' })
      if (!response.ok) throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `Discovery freshness receipt read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      const rows: unknown = await response.json().catch(() => undefined)
      if (!Array.isArray(rows) || rows.length > 1) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Discovery freshness receipt response is invalid.', false)
      if (!rows.length) return null
      const row = rows[0], provenance = row?.provenance
      if (!row || row.user_id !== userId || row.operation !== 'ingest_verified_discovery' || row.status !== 'COMMITTED' || row.principal_kind !== 'automation'
        || typeof row.command_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.payload_hash ?? '') || !validRevision(row.resulting_revision)
        || !provenance || provenance.sourceId !== sourceId || provenance.scopeFingerprint !== scopeFingerprint || provenance.producer !== 'server_scheduler'
        || typeof provenance.runId !== 'string' || !provenance.runId || provenance.runId.length > 180
        || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
        || !row.receipt || typeof row.receipt !== 'object' || Array.isArray(row.receipt)
        || Date.parse(row.receipt.committedAt) !== Date.parse(row.created_at)) {
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Discovery freshness receipt identity or original server time is invalid.', false)
      }
      return { commandId: row.command_id, operation: row.operation, payloadHash: row.payload_hash, resultingRevision: row.resulting_revision,
        receipt: row.receipt, runId: provenance.runId, createdAt: row.created_at }
    },

    async readDiscoveryScopeRecordsForUser(userId: string, sourceId: string, scopeFingerprint: string, planFingerprint: string, cycleId?: string): Promise<DiscoveryScopeLedgerRecord[]> {
      if (!userId || !sourceId || sourceId.length > 180 || ![scopeFingerprint, planFingerprint, ...(cycleId ? [cycleId] : [])].every(value => /^[a-f0-9]{64}$/.test(value))) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Invalid search progress identity.', false)
      const params = new URLSearchParams({
        select: 'user_id,command_id,operation,payload_hash,resulting_revision,receipt,status,provenance,created_at,principal_kind',
        user_id: `eq.${userId}`, status: 'eq.COMMITTED', principal_kind: 'eq.automation',
        'provenance->>sourceId': `eq.${sourceId}`, 'provenance->>scopeFingerprint': `eq.${scopeFingerprint}`,
        'provenance->>producer': 'eq.server_scheduler', 'provenance->>searchPlanFingerprint': `eq.${planFingerprint}`,
        ...(cycleId ? { 'provenance->>searchCycleId': `eq.${cycleId}` } : {
          operation: 'eq.checkpoint_discovery_search', 'provenance->>searchPhase': 'eq.claimed', 'provenance->>searchBatchIndex': 'eq.0',
        }),
        order: 'created_at.desc,resulting_revision.desc', limit: cycleId ? '161' : '1',
      })
      const response = await request(`/rest/v1/pjsdas_command_ledger?${params}`, { method: 'GET' })
      if (!response.ok) throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `Search progress read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      const rows: unknown = await response.json().catch(() => undefined)
      if (!Array.isArray(rows) || rows.length > (cycleId ? 160 : 1)) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Search progress exceeded its bounded ledger query.', false)
      return rows.map(row => {
        const provenance = row?.provenance, parsed = discoveryScopeBatchSchema.safeParse(provenance?.searchBatch)
        if (!row || row.user_id !== userId || row.status !== 'COMMITTED' || row.principal_kind !== 'automation'
          || !['checkpoint_discovery_search', 'ingest_verified_discovery'].includes(row.operation)
          || !provenance || provenance.sourceId !== sourceId || provenance.scopeFingerprint !== scopeFingerprint || provenance.producer !== 'server_scheduler'
          || provenance.searchPlanFingerprint !== planFingerprint || !parsed.success || parsed.data.planFingerprint !== planFingerprint
          || provenance.searchCycleId !== parsed.data.cycleId || cycleId && parsed.data.cycleId !== cycleId
          || provenance.searchPhase !== parsed.data.phase || provenance.searchBatchIndex !== parsed.data.index
          || !cycleId && (row.operation !== 'checkpoint_discovery_search' || parsed.data.phase !== 'claimed' || parsed.data.index !== 0)
          || typeof provenance.runId !== 'string' || !provenance.runId || provenance.runId.length > 180
          || typeof row.command_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.payload_hash ?? '') || !validRevision(row.resulting_revision)
          || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
          || !row.receipt || typeof row.receipt !== 'object' || Array.isArray(row.receipt)
          || Date.parse(row.receipt.committedAt) !== Date.parse(row.created_at)) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Search progress authority or coverage does not match.', false)
        return { commandId: row.command_id, operation: row.operation, payloadHash: row.payload_hash, resultingRevision: row.resulting_revision,
          receipt: row.receipt, createdAt: row.created_at, runId: provenance.runId, batch: parsed.data }
      })
    },

    async readCommandsAfterRevision(userId: string, revision: number): Promise<ConnectedCommandRecord[]> {
      const params = new URLSearchParams({
        select: 'command_id,operation,payload_hash,resulting_revision,receipt,compensation,status',
        user_id: `eq.${userId}`,
        status: 'eq.COMMITTED',
        resulting_revision: `gt.${revision}`,
        order: 'resulting_revision.asc',
      })
      const response = await request(`/rest/v1/pjsdas_command_ledger?${params.toString()}`, { method: 'GET' })
      if (!response.ok) {
        throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', `TodayAction command history read failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      }
      const rows = await response.json().catch(() => undefined) as Record<string, unknown>[] | undefined
      if (!rows) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction command history returned invalid JSON.', false)
      return rows.map((row) => {
        if (
          typeof row.command_id !== 'string'
          || typeof row.operation !== 'string'
          || typeof row.payload_hash !== 'string'
          || !validRevision(row.resulting_revision)
        ) {
          throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction command history metadata is invalid.', false)
        }
        return {
          commandId: row.command_id,
          operation: row.operation,
          payloadHash: row.payload_hash,
          resultingRevision: row.resulting_revision,
          receipt: typeof row.receipt === 'object' && row.receipt !== null ? row.receipt as Record<string, unknown> : {},
          compensation: typeof row.compensation === 'object' && row.compensation !== null ? row.compensation as Record<string, unknown> : undefined,
        }
      })
    },

    async bootstrapForUser(input: {
      userId: string
      snapshot: PJSDASSnapshot
      schemaVersion: number
      sourceFingerprint?: string
      migratedFrom?: string
      consumerAudienceMode?: 'allowlist' | 'legacy'
    }): Promise<ConnectedWorkspaceRecord> {
      validateSnapshot(input.snapshot)
      const snapshot = upgradeSnapshotToLatest(input.snapshot)
      const response = await request(input.consumerAudienceMode ? '/rest/v1/rpc/pjsdas_bootstrap_consumer_workspace_v1' : '/rest/v1/rpc/pjsdas_bootstrap_workspace', {
        method: 'POST',
        body: JSON.stringify({
          target_user_id: input.userId,
          initial_snapshot: snapshot,
          initial_schema_version: snapshot.version,
          initial_source_fingerprint: input.sourceFingerprint ?? null,
          initial_migrated_from: input.migratedFrom ?? null,
          ...(input.consumerAudienceMode ? { target_first_party: true, target_audience_mode: input.consumerAudienceMode } : {}),
        }),
      })
      if (!response.ok) {
        throw new WorkspaceSourceError('WORKSPACE_MIGRATION_FAILED', `TodayAction workspace bootstrap failed (HTTP ${response.status}).`, response.status >= 500 || response.status === 429)
      }
      const rows = await response.json().catch(() => undefined) as Array<Record<string, unknown>> | undefined
      const row = rows?.[0]
      if (!row || typeof row.workspace_id !== 'string' || !validRevision(row.revision)) {
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction workspace bootstrap returned invalid metadata.', false)
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

    async commitAuthoritativeForUser(input: ConnectedAuthoritativeCommitInput): Promise<ConnectedCommitResult> {
      validateSnapshot(input.snapshot)
      const authorization = input.managementAuthorization
      const discovery = input.discoveryAuthorization
      if (['ingest_verified_discovery', 'checkpoint_discovery_search'].includes(input.operation)) {
        const validOwner = discovery?.userId === input.userId
        const sourceId = input.provenance?.sourceId
        const validAutomation = discovery?.kind === 'automation' && input.principalKind === 'automation'
          && !input.clientId && discovery.googleSubject && /^[0-9a-f-]{36}$/i.test(discovery.consentGeneration)
        const validDelegated = discovery?.kind === 'delegated_mcp' && input.principalKind === 'delegated_mcp'
          && discovery.clientId === input.clientId && discovery.sourceId === sourceId
          && /^[0-9a-f-]{36}$/i.test(discovery.grantId) && Number.isSafeInteger(discovery.grantRevision) && discovery.grantRevision > 0
        if (authorization || !validOwner || typeof sourceId !== 'string' || !sourceId || !(validAutomation || validDelegated)
          || input.operation === 'checkpoint_discovery_search' && !validAutomation) {
          throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery writes require the original, owner/source-bound admission proof.', false)
        }
      } else if (discovery) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery authorization cannot authorize another command family.', false)
      // Authorized management preserves validated raw facts, including v2 business edits.
      const checkpoint = input.operation === 'checkpoint_discovery_search'
      const snapshot = authorization || checkpoint ? structuredClone(input.snapshot) : upgradeSnapshotToLatest(input.snapshot)
      if ((input.operation === 'business_management' || input.operation === 'opportunity_management' || input.operation === 'planning_management' || input.operation === 'discovery_profile_management' || input.operation === 'private_reminder_management') && !authorization) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management writes require a transaction-bound grant.', false)
      if (authorization && (input.principalKind !== 'delegated_mcp' || !input.clientId || !authorization.grantId || !Number.isSafeInteger(authorization.grantRevision) || authorization.grantRevision < 1)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management transaction authorization is invalid.', false)
      if ((input.operation === 'private_reminder_management' && authorization?.consentVersion !== 6) || (input.operation === 'discovery_profile_management' && authorization?.consentVersion !== 5) || (input.operation === 'planning_management' && authorization?.consentVersion !== 4) || (input.operation === 'opportunity_management' && authorization?.consentVersion !== 3) || (input.operation === 'business_management' && authorization?.consentVersion !== undefined && ![2, 7].includes(authorization.consentVersion))) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management grant version does not match this operation.', false)
      if (authorization?.consentVersion !== undefined && ![2, 3, 4, 5, 6, 7].includes(authorization.consentVersion)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Unsupported management consent version.', false)
      const rpc = discovery ? 'pjsdas_commit_discovery_workspace_v1' : authorization?.consentVersion === 7 ? 'pjsdas_commit_consumer_business_workspace_v1' : authorization?.consentVersion === 6 ? 'pjsdas_commit_private_reminder_workspace_v1' : authorization?.consentVersion === 5 ? 'pjsdas_commit_discovery_profile_workspace_v1' : authorization?.consentVersion === 4 ? 'pjsdas_commit_planning_workspace_v1' : authorization?.consentVersion === 3 ? 'pjsdas_commit_opportunity_workspace_v1' : authorization ? 'pjsdas_commit_management_workspace_v1' : 'pjsdas_commit_workspace_v2'
      const response = await request(`/rest/v1/rpc/${rpc}?select=outcome,workspace_id,revision,receipt`, {
        method: 'POST',
        body: JSON.stringify({
          target_user_id: input.userId,
          target_command_id: input.commandId,
          target_operation: input.operation,
          target_payload_hash: input.payloadHash,
          target_expected_revision: input.expectedRevision,
          target_snapshot: snapshot,
          target_schema_version: checkpoint ? input.schemaVersion : snapshot.version,
          target_principal_kind: input.principalKind,
          target_client_id: input.clientId ?? null,
          target_provenance: input.provenance ?? {},
          target_compensation: input.compensation ?? null,
          target_effective_time: input.effectiveTime ?? null,
          target_receipt_context: input.receiptContext,
          ...(authorization ? { target_grant_id: authorization.grantId, target_grant_revision: authorization.grantRevision } : {}),
          ...(discovery ? { target_discovery_authorization: discovery } : {}),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string; details?: string; code?: string }
        if ((authorization || discovery) && (response.status === 403 || body.code === '42501')) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'The admitted authorization changed before commit; this work cannot be retried with a replacement grant.', false)
        const duplicateCommand = response.status === 409 || body.message?.includes('different payload') || body.details?.includes('different payload')
        throw new WorkspaceSourceError(
          duplicateCommand ? 'COMMAND_ID_REUSED' : 'WORKSPACE_COMMIT_FAILED',
          duplicateCommand ? 'TodayAction command id was reused with a different payload.' : `TodayAction authoritative commit failed (HTTP ${response.status}).`,
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
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction authoritative commit returned invalid metadata.', false)
      }
      let committedSnapshot = row.snapshot
      let committedRevision = row.revision
      if (committedSnapshot == null) {
        if (row.outcome === 'COMMITTED') committedSnapshot = snapshot
        else {
          const latest = await this.readForUser(input.userId, { preserveRawData: Boolean(authorization) || checkpoint })
          if (!latest || latest.workspaceId !== row.workspace_id || latest.revision < row.revision)
            throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Authoritative fallback snapshot metadata does not match the commit.', false)
          committedSnapshot = latest.snapshot
          committedRevision = latest.revision
        }
      }
      validateSnapshot(committedSnapshot)
      return {
        outcome: row.outcome as ConnectedCommitResult['outcome'],
        workspaceId: row.workspace_id,
        revision: committedRevision,
        snapshot: committedSnapshot as PJSDASSnapshot,
        receipt: typeof row.receipt === 'object' && row.receipt !== null ? row.receipt as Record<string, unknown> : {},
      }
    },

    async commitForUser(input: ConnectedCommitInput): Promise<ConnectedCommitResult> {
      if (['ingest_verified_discovery', 'checkpoint_discovery_search'].includes(input.operation)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery cannot use the legacy unguarded commit route.', false)
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
          duplicateCommand ? 'TodayAction command id was reused with a different payload.' : `TodayAction workspace commit failed (HTTP ${response.status}).`,
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
        throw new WorkspaceSourceError('WORKSPACE_INVALID', 'TodayAction commit returned invalid metadata.', false)
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
