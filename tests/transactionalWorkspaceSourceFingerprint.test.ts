import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as workspaceFingerprint from '../src/cloud/workspaceFingerprint.js'
import * as mutationKernel from '../gateway/mutationKernel.js'
import { createTransactionalWorkspaceSource } from '../gateway/transactionalWorkspaceSource.js'
import type { WorkspaceWriteCommand } from '../gateway/workspaceSource.js'
import { createSnapshot, upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

const CREATED = '2026-10-01T00:00:00.000Z'
const EXPORTED = '2026-10-01T00:01:00.000Z'
const NOW = '2026-10-01T00:02:00.000Z'
const PROVIDED_HASH = 'a'.repeat(64)
const SOURCE_ID = 'synthetic:source'
const USER_ID = 'synthetic-user'
const WRITER = 'synthetic-writer'
const AFFECTED_OBJECTS = [{ type: 'action', id: 'synthetic-action' }]

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function syntheticSnapshot(): PJSDASSnapshot {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], prep: [], applicationGroups: [],
    actions: [{ id: 'synthetic-action', kind: 'manual', title: 'Synthetic task', status: 'todo',
      estimatedMinutes: 30, leverage: 0, delayCost: 0, createdAt: CREATED, updatedAt: CREATED }],
  }, CREATED)
}

function semanticCommand(withHash: boolean): WorkspaceWriteCommand {
  return {
    commandId: 'synthetic-command', operation: 'set_action_status',
    payload: { status: 'done', actionId: 'synthetic-action' },
    ...(withHash ? { payloadHash: PROVIDED_HASH } : {}),
    compensation: { operation: 'set_action_status', payload: { actionId: 'synthetic-action', status: 'todo' } },
    provenance: { reason: 'synthetic-test-only' }, effectiveTime: CREATED,
  }
}

function expectedSemanticHash(withHash: boolean) {
  // Independent, fixed canonical-payload oracle; never hashes the workspace.
  return withHash ? PROVIDED_HASH : createHash('sha256')
    .update('{"operation":"set_action_status","payload":{"actionId":"synthetic-action","status":"done"}}').digest('hex')
}

function receiptContext(commandType: 'workspace_source_semantic' | 'workspace_source_compatibility', affectedObjects = AFFECTED_OBJECTS) {
  return {
    contractVersion: 2, commandType, affectedObjects, undoDependencyObjects: affectedObjects,
    readModelInvalidation: affectedObjects.length ? ['action'] : [],
    lifecycle: { receivedAt: NOW, validatedAt: NOW, baseRevision: 7, authoritativeRevisionBeforeCommit: 7, rebased: false },
  }
}

function fixture(checkpoint = false) {
  let current = syntheticSnapshot(), revision = 7
  if (checkpoint) current = { schema: 'pjsdas-local-snapshot', version: 1, exportedAt: CREATED,
    data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] } }
  const original = structuredClone(current)
  const next = structuredClone(current)
  next.exportedAt = EXPORTED
  if (!checkpoint) {
    next.data.actions[0].status = 'done'
    next.data.actions[0].updatedAt = EXPORTED
  }
  const bodies: Record<string, any>[] = []
  const paths: string[] = []
  const ledger = new Map<string, { hash: string; receipt: Record<string, unknown> }>()
  let beforeCommit: (() => void) | undefined
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://fixture.invalid')
    paths.push(url.pathname)
    if (url.pathname === '/rest/v1/pjsdas_workspaces') {
      expect(url.searchParams.get('user_id')).toBe(`eq.${USER_ID}`)
      return json([{ id: 'synthetic-workspace', user_id: USER_ID, revision,
        schema_version: current.version, snapshot: current }])
    }
    expect(url.pathname).toBe(checkpoint ? '/rest/v1/rpc/pjsdas_commit_discovery_workspace_v1' : '/rest/v1/rpc/pjsdas_commit_workspace_v2')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    const hook = beforeCommit; beforeCommit = undefined; hook?.()
    const existing = ledger.get(body.target_command_id)
    if (existing) {
      expect(body.target_payload_hash).toBe(existing.hash)
      return json([{ outcome: 'ALREADY_APPLIED', workspace_id: 'synthetic-workspace', revision,
        snapshot: current, receipt: existing.receipt }])
    }
    if (body.target_expected_revision !== revision) {
      return json([{ outcome: 'CONFLICT', workspace_id: 'synthetic-workspace', revision,
        snapshot: current, receipt: {} }])
    }
    current = body.target_snapshot; revision++
    const receipt = { ...body.target_receipt_context, status: 'COMMITTED', revision,
      commandId: body.target_command_id, committedAt: NOW }
    ledger.set(body.target_command_id, { hash: body.target_payload_hash, receipt })
    return json([{ outcome: 'COMMITTED', workspace_id: 'synthetic-workspace', revision, receipt }])
  })
  const source = createTransactionalWorkspaceSource({
    userId: USER_ID, supabaseUrl: 'https://fixture.invalid', serviceRoleKey: 'synthetic-only',
    principalKind: checkpoint ? 'automation' : 'delegated_mcp',
    ...(checkpoint ? {} : { clientId: 'synthetic-client' }), sourceId: SOURCE_ID,
    fetchImpl, now: () => new Date(NOW),
  })
  return {
    source, original, next, bodies, paths,
    current: () => structuredClone(current),
    raceAtCommit: () => { beforeCommit = () => { current.data.actions[0].title = 'Synthetic concurrent edit'; revision++ } },
  }
}

function expectedSemanticBody(next: PJSDASSnapshot, command: WorkspaceWriteCommand, hash: string) {
  const committed = upgradeSnapshotToLatest(next)
  return {
    target_user_id: USER_ID, target_command_id: command.commandId, target_operation: command.operation,
    target_payload_hash: hash, target_expected_revision: 7, target_snapshot: committed,
    target_schema_version: committed.version, target_principal_kind: 'delegated_mcp', target_client_id: 'synthetic-client',
    target_provenance: { writer: WRITER, sourceId: SOURCE_ID, reason: 'synthetic-test-only' },
    target_compensation: command.compensation, target_effective_time: CREATED,
    target_receipt_context: receiptContext('workspace_source_semantic'),
  }
}

beforeEach(() => {
  vi.stubEnv('PJSDAS_WORKSPACE_COMMIT_METADATA_ONLY', '0')
  vi.stubEnv('PJSDAS_WORKSPACE_COMMIT_RAW_JSON', '0')
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real network is forbidden in this synthetic test.') }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('transactional source avoids unused semantic workspace fingerprints', () => {
  it.each([true, false])('preserves the full semantic RPC and receipt without workspace hashing (provided hash: %s)', async withHash => {
    const f = fixture(), command = semanticCommand(withHash)
    const fingerprint = vi.spyOn(workspaceFingerprint, 'fingerprintWorkspace')
    const payloadHash = vi.spyOn(mutationKernel, 'hashMutationPayload')
    const written = await f.source.write!({ snapshot: f.next, expectedWorkspaceVersion: 'txn:7', updatedByDevice: ` ${WRITER} `, command })

    expect(f.bodies).toEqual([expectedSemanticBody(f.next, command, expectedSemanticHash(withHash))])
    expect(written).toEqual({
      snapshot: upgradeSnapshotToLatest(f.next), commandOutcome: 'COMMITTED',
      commandReceipt: { ...receiptContext('workspace_source_semantic'), status: 'COMMITTED', revision: 8,
        commandId: command.commandId, committedAt: NOW },
      context: { now: new Date(NOW), timezone: 'UTC', workspaceVersion: 'txn:8', workspaceOwnerUserId: USER_ID },
    })
    expect(payloadHash).toHaveBeenCalledTimes(withHash ? 0 : 1)
    if (!withHash) expect(payloadHash).toHaveBeenCalledWith(command.operation, command.payload)
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it.each([true, false])('cannot change semantic RPC inputs or receipts by changing the unused fingerprint (provided hash: %s)', async withHash => {
    const fingerprint = vi.spyOn(workspaceFingerprint, 'fingerprintWorkspace')
    const left = fixture(), right = fixture(), command = semanticCommand(withHash)
    fingerprint.mockResolvedValue('1'.repeat(64))
    const first = await left.source.write!({ snapshot: left.next, expectedWorkspaceVersion: 'txn:7', updatedByDevice: WRITER, command })
    fingerprint.mockResolvedValue('2'.repeat(64))
    const second = await right.source.write!({ snapshot: right.next, expectedWorkspaceVersion: 'txn:7', updatedByDevice: WRITER, command })
    expect(left.bodies).toEqual([expectedSemanticBody(left.next, command, expectedSemanticHash(withHash))])
    expect(right.bodies).toEqual(left.bodies)
    expect(second).toEqual(first)
  })

  it('retains exact atomic CAS and never overwrites the concurrent snapshot for a semantic command', async () => {
    const f = fixture(), command = semanticCommand(false)
    const fingerprint = vi.spyOn(workspaceFingerprint, 'fingerprintWorkspace')
    f.raceAtCommit()
    await expect(f.source.write!({ snapshot: f.next, expectedWorkspaceVersion: 'txn:7', updatedByDevice: WRITER, command }))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT', retryable: true })
    expect(f.bodies).toEqual([expectedSemanticBody(f.next, command, expectedSemanticHash(false))])
    const concurrent = structuredClone(f.original)
    concurrent.data.actions[0].title = 'Synthetic concurrent edit'
    expect(f.current()).toEqual(concurrent)
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it('retains semantic replay identity and returns the original server receipt', async () => {
    const f = fixture(), command = semanticCommand(true)
    const fingerprint = vi.spyOn(workspaceFingerprint, 'fingerprintWorkspace')
    const input = { snapshot: f.next, expectedWorkspaceVersion: 'txn:7', updatedByDevice: WRITER, command }
    const first = await f.source.write!(input)
    const replay = await f.source.write!(input)
    expect(replay).toEqual({ ...first, commandOutcome: 'ALREADY_APPLIED' })
    expect(f.bodies).toHaveLength(2)
    expect(f.bodies[1].target_command_id).toBe(f.bodies[0].target_command_id)
    expect(f.bodies[1].target_payload_hash).toBe(PROVIDED_HASH)
    expect(f.bodies[1].target_expected_revision).toBe(7)
    expect(f.current()).toEqual(first.snapshot)
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it('preserves raw checkpoint schema, admission proof, CAS, and receipt without workspace hashing', async () => {
    const f = fixture(true)
    const fingerprint = vi.spyOn(workspaceFingerprint, 'fingerprintWorkspace')
    const authorization = { kind: 'automation' as const, userId: USER_ID, googleSubject: 'synthetic-subject',
      consentGeneration: '11111111-1111-4111-8111-111111111111' }
    const command: WorkspaceWriteCommand = { commandId: 'synthetic-checkpoint', operation: 'checkpoint_discovery_search',
      payload: { synthetic: true }, payloadHash: PROVIDED_HASH, discoveryAuthorization: authorization }
    const written = await f.source.write!({ snapshot: f.next, expectedWorkspaceVersion: 'txn:7', updatedByDevice: WRITER, command })
    expect(f.bodies).toEqual([{
      target_user_id: USER_ID, target_command_id: command.commandId, target_operation: command.operation,
      target_payload_hash: PROVIDED_HASH, target_expected_revision: 7, target_snapshot: f.next,
      target_schema_version: 1, target_principal_kind: 'automation', target_client_id: null,
      target_provenance: { writer: WRITER, sourceId: SOURCE_ID }, target_compensation: null,
      target_effective_time: EXPORTED, target_receipt_context: receiptContext('workspace_source_semantic', []),
      target_discovery_authorization: authorization,
    }])
    expect(written.snapshot).toEqual(f.next)
    expect(written.commandReceipt).toEqual({ ...receiptContext('workspace_source_semantic', []), status: 'COMMITTED',
      revision: 8, commandId: command.commandId, committedAt: NOW })
    expect(written.context.workspaceVersion).toBe('txn:8')
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it('still fingerprints compatibility writes exactly once and reuses that hash for identity and payload', async () => {
    const f = fixture()
    const expectedHash = createHash('sha256').update(workspaceFingerprint.canonicalWorkspaceJson(f.next)).digest('hex')
    const fingerprint = vi.spyOn(workspaceFingerprint, 'fingerprintWorkspace')
    const payloadHash = vi.spyOn(mutationKernel, 'hashMutationPayload')
    const written = await f.source.write!({ snapshot: f.next, expectedWorkspaceVersion: 'txn:7', updatedByDevice: WRITER })
    const committed = upgradeSnapshotToLatest(f.next)
    expect(f.bodies).toEqual([{
      target_user_id: USER_ID, target_command_id: `snapshot-write:${WRITER}:7:${expectedHash}`,
      target_operation: 'SnapshotWrite', target_payload_hash: expectedHash, target_expected_revision: 7,
      target_snapshot: committed, target_schema_version: committed.version,
      target_principal_kind: 'delegated_mcp', target_client_id: 'synthetic-client',
      target_provenance: { writer: WRITER, sourceId: SOURCE_ID }, target_compensation: null,
      target_effective_time: EXPORTED, target_receipt_context: receiptContext('workspace_source_compatibility'),
    }])
    expect(written.commandReceipt).toEqual({ ...receiptContext('workspace_source_compatibility'), status: 'COMMITTED',
      revision: 8, commandId: `snapshot-write:${WRITER}:7:${expectedHash}`, committedAt: NOW })
    expect(written.snapshot).toEqual(committed)
    expect(written.context.workspaceVersion).toBe('txn:8')
    expect(fingerprint).toHaveBeenCalledExactlyOnceWith(f.next)
    expect(payloadHash).not.toHaveBeenCalled()
  })
})
