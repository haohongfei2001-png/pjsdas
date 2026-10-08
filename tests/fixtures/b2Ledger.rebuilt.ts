import { vi } from 'vitest'
import { createSnapshot, type PJSDASSnapshot } from '../../src/snapshot.js'
import { createDefaultDiscoveryProfile } from '../../src/discoveryProfile.js'
import { discoveryProfileManagementFingerprint } from '../../src/discoveryProfileManagement.js'
import { applyUserDomainCommand } from '../../src/domainCommands.js'
import { createTransactionalWorkspaceSource } from '../../gateway/transactionalWorkspaceSource.js'
import { prepareVerifiedDiscoveryCommand } from '../../gateway/verifiedDiscoveryCommit.js'
import { runDiscoveryAutomationForBinding } from '../../gateway/discoveryAutomationWorker.js'
import type { VerifiedDiscoveryCommand } from '../../src/verifiedDiscoveryCommand.js'
import type { DiscoveryCommitAuthorization } from '../../gateway/workspaceSource.js'

// Rebuilt offline tests. This models ledger/CAS invariants, not PostgreSQL locks
// or production search evidence. Every fetch is intercepted and unexpected
// paths fail; no credentials, provider, network, or database are used.
export const AT = '2026-10-07T20:00:00.000Z'
export const USER = '00000000-0000-4000-8000-000000000001'
export const CLIENT = 'rebuilt-client'
export const SOURCE = 'monitor:urgent-campus'
export const GENERATION = '11111111-1111-4111-8111-111111111111'
export const GRANT = '22222222-2222-4222-8222-222222222222'
export const AUTOMATION = { kind: 'automation', userId: USER, googleSubject: 'synthetic-subject', consentGeneration: GENERATION } satisfies DiscoveryCommitAuthorization
export const DELEGATED = { kind: 'delegated_mcp', userId: USER, clientId: CLIENT, sourceId: SOURCE, grantId: GRANT, grantRevision: 7 } satisfies DiscoveryCommitAuthorization
export const clone = <T>(value: T): T => structuredClone(value)
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

export function snapshot(): PJSDASSnapshot {
  return createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [], changeSets: [],
    discoveryProfile: { ...createDefaultDiscoveryProfile(AT), searchScopeVersion: 1, targetRoleQueries: ['Product Manager'] },
  }, AT)
}

export async function command(input: { runId?: string; sourceId?: string; at?: string; company?: string; scheduled?: boolean; postingId?: string } = {}) {
  const at = input.at ?? AT
  const url = `https://jobs.lever.co/rebuilt/${input.postingId ?? '7e909663-02d6-4f38-bbc6-d3c087ed05ab'}`
  const identity = input.postingId ? `verified:rebuilt-posting:${input.postingId}` : 'verified:rebuilt-posting'
  const company = input.company ?? 'Rebuilt Ledger Company'
  const observation: VerifiedDiscoveryCommand['run']['observations'][number] = {
    sourceRecordId: identity, company, role: 'Product Manager', sourceUrl: url, sourceTitle: 'Product Manager',
    sourceVerification: 'verified', sourceVerifiedAt: at, discoveredAt: at,
    sourceProof: { version: 1, authority: 'ats', authorityUrl: 'https://jobs.lever.co', requestedUrl: url, finalUrl: url,
      verifiedAt: at, documentSha256: 'a'.repeat(64), postingIdentity: identity, fields: [
        { field: 'company', value: company, sourceUrl: url, selector: 'fixture:company', quote: company },
        { field: 'role', value: 'Product Manager', sourceUrl: url, selector: 'fixture:title', quote: 'Product Manager' },
      ] },
  }
  return prepareVerifiedDiscoveryCommand({ request: { runId: input.runId ?? 'rebuilt-run-1', sourceId: input.sourceId ?? SOURCE },
    scopeFingerprint: await discoveryProfileManagementFingerprint(snapshot().data.discoveryProfile!),
    run: { runId: input.runId ?? 'rebuilt-run-1', sourceId: input.sourceId ?? SOURCE, producer: input.scheduled ? 'server_scheduler' : 'mcp_trusted_ingestion',
      startedAt: at, completedAt: at, observations: [observation],
      ...(input.scheduled ? { searchExecutions: [{ version: 1 as const, provider: 'offline-rebuilt', requestId: 'query-1', query: { query: 'Product Manager', coverage: 'general_web' as const },
        startedAt: at, completedAt: at, outcome: 'success' as const, providerRequestId: 'response-1', responseSha256: 'b'.repeat(64), resultCount: 1 }] } : {}),
    } })
}

export interface LedgerRow {
  user_id: string; command_id: string; operation: string; payload_hash: string; resulting_revision: number;
  receipt: Record<string, unknown>; status: string; principal_kind: string; provenance: Record<string, unknown>; created_at: string
}
export interface RpcBody {
  target_user_id: string; target_command_id: string; target_operation: string; target_payload_hash: string;
  target_expected_revision: number; target_snapshot: PJSDASSnapshot; target_principal_kind: string; target_client_id: string | null;
  target_provenance: Record<string, unknown>; target_discovery_authorization?: DiscoveryCommitAuthorization
}

export class LedgerHarness {
  snapshot = snapshot()
  revision = 1
  now = new Date(AT)
  readonly rows = new Map<string, LedgerRow>()
  readonly calls: Array<{ url: URL; method: string; body?: RpcBody }> = []
  readonly writes: RpcBody[] = []
  readonly attempts: RpcBody[] = []
  liveAuthorization: DiscoveryCommitAuthorization = clone(AUTOMATION)
  beforeCommit?: (body: RpcBody) => void | Promise<void>
  responseTransform?: (response: Record<string, unknown>) => Record<string, unknown>
  ledgerTransform?: (rows: LedgerRow[], url: URL) => LedgerRow[]
  lostAck = false
  failWorkspaceAfterCommit = false
  failLedgerAfterCommit = false
  readonly unexpectedUrls: string[] = []

  source(authorization: DiscoveryCommitAuthorization = this.liveAuthorization) {
    return createTransactionalWorkspaceSource({ userId: USER, supabaseUrl: 'https://offline.invalid', serviceRoleKey: 'synthetic-unused-key',
      principalKind: authorization.kind === 'automation' ? 'automation' : 'delegated_mcp',
      clientId: authorization.kind === 'delegated_mcp' ? CLIENT : undefined, sourceId: SOURCE, now: () => new Date(this.now), fetchImpl: this.fetch })
  }

  private row(body: RpcBody): LedgerRow {
    return { user_id: body.target_user_id, command_id: body.target_command_id, operation: body.target_operation,
      payload_hash: body.target_payload_hash, resulting_revision: this.revision, status: 'COMMITTED', principal_kind: body.target_principal_kind,
      provenance: clone(body.target_provenance), created_at: this.now.toISOString(),
      receipt: { receiptId: `command-receipt:${body.target_command_id}`, commandId: body.target_command_id,
        operation: body.target_operation, revision: this.revision, status: 'COMMITTED', committedAt: this.now.toISOString() } }
  }

  // An independently applied winner has its own domain output and receipt. An
  // ALREADY_APPLIED response below NEVER accepts the losing proposed snapshot.
  seedWinner(value: VerifiedDiscoveryCommand, at = this.now) {
    if (this.rows.has(value.commandId)) throw new Error('Fixture cannot rewrite an original receipt')
    this.snapshot = applyUserDomainCommand(this.snapshot, value, at).snapshot
    this.revision += 1
    const body: RpcBody = { target_user_id: USER, target_command_id: value.commandId, target_operation: value.kind,
      target_payload_hash: value.inputFingerprint, target_expected_revision: this.revision - 1, target_snapshot: this.snapshot,
      target_principal_kind: value.run.producer === 'server_scheduler' ? 'automation' : 'delegated_mcp', target_client_id: null,
      target_provenance: { sourceId: value.run.sourceId, scopeFingerprint: value.scopeFingerprint, producer: value.run.producer, runId: value.run.runId } }
    const row = this.row(body)
    row.created_at = at.toISOString(); row.receipt.committedAt = at.toISOString()
    this.rows.set(value.commandId, clone(row))
    return clone(row)
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as RpcBody : undefined
    this.calls.push({ url, method, body: body && clone(body) })
    if (url.pathname === '/rest/v1/pjsdas_workspaces' && method === 'GET') {
      if (this.failWorkspaceAfterCommit && this.writes.length) return json({ error: 'offline readback unavailable' }, 503)
      if (url.searchParams.get('user_id') !== `eq.${USER}`) throw new Error('Fixture requires the exact account query')
      return json([{ id: 'rebuilt-workspace', user_id: USER, revision: this.revision, schema_version: this.snapshot.version, snapshot: clone(this.snapshot) }])
    }
    if (url.pathname === '/rest/v1/pjsdas_command_ledger' && method === 'GET') {
      if (this.failLedgerAfterCommit && this.writes.length) return json({ error: 'offline ledger unavailable' }, 503)
      let rows = [...this.rows.values()].filter(row => {
        for (const [key, expression] of url.searchParams) {
          if (!expression.startsWith('eq.')) continue
          const actual = key.startsWith('provenance->>') ? row.provenance[key.slice(13)] : row[key as keyof LedgerRow]
          if (String(actual) !== expression.slice(3)) return false
        }
        return true
      }).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.resulting_revision - a.resulting_revision)
      if (url.searchParams.get('limit') === '1') rows = rows.slice(0, 1)
      return json(this.ledgerTransform?.(clone(rows), url) ?? clone(rows))
    }
    if (url.pathname === '/rest/v1/rpc/pjsdas_commit_discovery_workspace_v1' && method === 'POST' && body) {
      this.attempts.push(clone(body))
      await this.beforeCommit?.(body)
      if (JSON.stringify(body.target_discovery_authorization) !== JSON.stringify(this.liveAuthorization)) return json({ code: '42501' }, 403)
      const previous = this.rows.get(body.target_command_id)
      if (previous) {
        if (previous.payload_hash !== body.target_payload_hash) return json({ message: 'different payload' }, 409)
        // The v2 RPC returns current workspace revision, while its immutable
        // receipt retains the original command's earlier resulting revision.
        return json([this.responseTransform?.({ outcome: 'ALREADY_APPLIED', workspace_id: 'rebuilt-workspace', revision: this.revision, receipt: clone(previous.receipt) })
          ?? { outcome: 'ALREADY_APPLIED', workspace_id: 'rebuilt-workspace', revision: this.revision, receipt: clone(previous.receipt) }])
      }
      if (body.target_expected_revision !== this.revision) return json([{ outcome: 'CONFLICT', workspace_id: 'rebuilt-workspace', revision: this.revision, receipt: {} }])
      this.snapshot = clone(body.target_snapshot)
      this.revision += 1
      const row = this.row(body)
      this.rows.set(row.command_id, clone(row))
      this.writes.push(clone(body))
      if (this.lostAck) throw new Error('Synthetic lost acknowledgement after commit')
      const result = { outcome: 'COMMITTED', workspace_id: 'rebuilt-workspace', revision: this.revision, receipt: clone(row.receipt) }
      return json([this.responseTransform?.(result) ?? result])
    }
    this.unexpectedUrls.push(url.href)
    throw new Error(`Unexpected offline fixture route: ${url.pathname}`)
  }
}

export function scheduler(harness: LedgerHarness) {
  const reserveSearch = vi.fn(async request => ({ ...request, reservationId: `reserved:${request.requestId}`, reservedUsd: request.maximumCostUsd, expiresAt: '2099-01-01T00:00:00.000Z' }))
  const reserveSpend = vi.fn(async request => ({ ...request, reservationId: `model:${request.requestId}`, reservedUsd: 1, expiresAt: '2099-01-01T00:00:00.000Z' }))
  const search = vi.fn(async () => ({ providerRequestId: `offline-response:${search.mock.calls.length}`, results: [{ url: 'https://example.test/job', title: 'Synthetic hit' }] }))
  const generateTextImpl = vi.fn(async () => ({ text: '{"observations":[]}' }))
  const authorize = vi.fn(async () => {
    if (JSON.stringify(harness.liveAuthorization) !== JSON.stringify(AUTOMATION)) throw new (await import('../../gateway/workspaceSource.js')).WorkspaceSourceError('AUTH_FORBIDDEN', 'Synthetic consent revoked', false)
  })
  const run = (force = false, overrides: Partial<Parameters<typeof runDiscoveryAutomationForBinding>[0]> = {}) => runDiscoveryAutomationForBinding({ binding: { userId: USER, googleSubject: 'synthetic-subject', refreshTokenCiphertext: 'unused', grantedScopes: [], discoveryConsentGeneration: GENERATION },
    tokenEncryptionKey: '', googleClientId: '', googleClientSecret: '', fetchImpl: harness.fetch, now: () => new Date(harness.now), force,
    reserveSearch, reserveSpend, searchProvider: { id: 'offline-rebuilt', maximumRequestCostUsd: 0.01, search }, generateTextImpl, authorize, ...overrides })
  return { run, search, reserveSearch, reserveSpend, generateTextImpl, authorize }
}
