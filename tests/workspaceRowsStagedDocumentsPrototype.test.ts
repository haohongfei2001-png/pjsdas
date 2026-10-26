import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStagedDocumentReceiver, parseStagedDocumentManifest, prepareStagedRequestDocuments, stagedDocumentFragmentBytes, uploadStagedRequestDocuments, type StagedDocumentName, type StagedDocumentTransport, type StagedRequestBinding } from '../gateway/workspaceRowsStagedDocumentsPrototype.js'
import { prepareStagedEffects } from '../gateway/workspaceRowsLargeCommandPrototype.js'
import { createWorkspaceRowsCandidate } from '../gateway/workspaceRowsCandidate.js'
import { createConnectedWorkspaceHandler } from '../gateway/connectedWorkspaceHandler.js'
import { diffReadableWorkspaceRows } from '../gateway/workspaceRowsCodec.js'
import { largePlanningFixture } from './fixtures/workspaceRowsLargePlanning.js'
import { largeAbandonFixture } from './fixtures/workspaceRowsLargeCommand.js'

const userId = '11111111-1111-4111-8111-111111111111', workspaceId = '22222222-2222-4222-8222-222222222222'
const expectedEpoch = '33333333-3333-4333-8333-333333333333'
const binding: StagedRequestBinding = {
  stageId: '44444444-4444-4444-8444-444444444444', family: 'planning_v4', userId, workspaceId, expectedEpoch,
  expectedRevision: 0, commandId: 'synthetic-documents', payloadHash: 'a'.repeat(64), operation: 'planning_management', principal: 'delegated_mcp',
  authority: { grantId: '55555555-5555-4555-8555-555555555555', grantRevision: 3, clientId: 'synthetic-client' },
}
const effects = { protocol: 'workspace-effect-chain-v1' as const, count: 0, sha256: '0'.repeat(64) }
const identity = (value = binding) => ({ userId: value.userId, workspaceId: value.workspaceId, expectedEpoch: value.expectedEpoch,
  expectedRevision: value.expectedRevision, commandId: value.commandId, payloadHash: value.payloadHash, operation: value.operation, principal: value.principal })
function simple() {
  // Force a four-byte Unicode scalar to span a 64 KiB byte boundary.
  return { ...identity(), beforeEnvelope: { unknown: 'x'.repeat(65_522) + '😀汉字\\"'.repeat(10_000) }, afterEnvelope: { future: { retained: true } },
    compensation: { operation: 'original_restore', payload: { rawBefore: null, retained: '汉'.repeat(40_000) } },
    receiptContext: { contractVersion: 5, projectionDelta: { exact: true }, futureAuditField: { retained: true } },
    provenance: { source: 'synthetic' }, futureRequestField: [null, true, { exact: '✓' }] }
}
function receiver(prepared: ReturnType<typeof prepareStagedRequestDocuments>, signal = new AbortController().signal) {
  return createStagedDocumentReceiver({ manifest: prepared.manifest, expectedBinding: prepared.manifest.binding,
    expectedEffects: prepared.manifest.effects, reservedBytes: prepared.totalBytes, signal })
}
afterEach(() => vi.unstubAllEnvs())

describe('offline staged metadata/header/compensation byte protocol', () => {
  it('preserves every JSON-wire field, raw header, compensation and V5 delta across UTF-8 splits', () => {
    const request = simple(), prepared = prepareStagedRequestDocuments(request, binding, effects), sink = receiver(prepared)
    const fragments = [...prepared.fragments()]
    expect(fragments.length).toBeGreaterThan(4)
    for (const part of fragments) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(90_000)
      expect(Buffer.from(part.base64, 'base64').length).toBeLessThanOrEqual(stagedDocumentFragmentBytes)
      sink.append(part)
    }
    expect(sink.reconstructForFinalAuthorization()).toEqual(request)
    expect(() => sink.append(fragments[0])).toThrow('SEALED')
  })
  it('freezes the prepared byte identity against caller mutation', () => {
    const request = simple(), expected = structuredClone(request), context = structuredClone(binding)
    const prepared = prepareStagedRequestDocuments(request, context, effects)
    request.receiptContext.contractVersion = 2; request.compensation.payload.retained = 'changed'; context.authority.grantRevision = 999
    const sink = receiver(prepared); for (const part of prepared.fragments()) sink.append(part)
    expect(sink.reconstructForFinalAuthorization()).toEqual(expected)
    expect(prepared.manifest.binding.authority.grantRevision).toBe(3)
  })
  it('provides an exact manifest text/hash pair instead of depending on JSONB key order or whitespace', () => {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects)
    expect(parseStagedDocumentManifest(prepared.manifestWire, prepared.manifest.sha256)).toEqual(prepared.manifest)
    expect(() => parseStagedDocumentManifest(prepared.manifestWire + ' ', prepared.manifest.sha256)).toThrow('DIGEST')
  })
  it('allows only exact duplicate/resumed fragments, with no partial authority document', () => {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects), sink = receiver(prepared), parts = [...prepared.fragments()]
    sink.append(parts[0]); expect(sink.append(parts[0]).nextOffset).toBe(Buffer.from(parts[0].base64, 'base64').length)
    expect(() => sink.reconstructForFinalAuthorization()).toThrow('INCOMPLETE')
    for (const part of parts.slice(1)) sink.append(part)
    expect(sink.reconstructForFinalAuthorization()).toEqual(simple())
  })
  it.each(['stageId', 'manifestSha256', 'offset', 'base64'] as const)('rejects mismatched fragment %s', field => {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects), sink = receiver(prepared), part = [...prepared.fragments()][0]
    const changed = { ...part, [field]: field === 'offset' ? 1 : 'invalid' }
    expect(() => sink.append(changed)).toThrow()
    expect(() => sink.reconstructForFinalAuthorization()).toThrow('INCOMPLETE')
  })
  it('rejects gaps, altered duplicates and full-length byte tampering', () => {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects), parts = [...prepared.fragments()]
    const header = parts.filter(p => p.document === 'beforeEnvelope'), sink = receiver(prepared)
    expect(() => sink.append(header[1])).toThrow('GAP')
    const corrupt = (part: typeof parts[number]) => {
      const bytes = Buffer.from(part.base64, 'base64'); bytes[bytes.length - 1] ^= 1
      return { ...part, base64: bytes.toString('base64') }
    }
    sink.append(header[0]); expect(() => sink.append(corrupt(header[0]))).toThrow('CHANGED_REPEATED')
    const other = receiver(prepared)
    for (const part of parts) other.append(part === header[0] ? corrupt(part) : part)
    expect(() => other.reconstructForFinalAuthorization()).toThrow('DIGEST_MISMATCH')
  })
  it.each(['family', 'userId', 'workspaceId', 'expectedEpoch', 'expectedRevision', 'commandId', 'payloadHash', 'operation', 'principal', 'authority'] as const)('binds final-authority context %s without treating upload as authorization', field => {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects)
    const expectedBinding = { ...binding, [field]: field === 'expectedRevision' ? 9 : field === 'authority' ? { ...binding.authority, grantRevision: 4 } : 'changed' }
    expect(() => createStagedDocumentReceiver({ manifest: prepared.manifest, expectedBinding, expectedEffects: effects, reservedBytes: prepared.totalBytes, signal: new AbortController().signal })).toThrow('CONTEXT_MISMATCH')
  })
  it('rejects a different effect chain, directory, hash, or insufficient prior resource reservation', () => {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects)
    const options = { manifest: prepared.manifest, expectedBinding: binding, expectedEffects: effects, reservedBytes: prepared.totalBytes, signal: new AbortController().signal }
    expect(() => createStagedDocumentReceiver({ ...options, expectedEffects: { ...effects, count: 1 } })).toThrow('CONTEXT_MISMATCH')
    expect(() => createStagedDocumentReceiver({ ...options, reservedBytes: prepared.totalBytes - 1 })).toThrow('RESOURCE_RESERVATION')
    expect(() => createStagedDocumentReceiver({ ...options, manifest: { ...prepared.manifest, documents: prepared.manifest.documents.slice(1) } })).toThrow('DIRECTORY')
    expect(() => createStagedDocumentReceiver({ ...options, manifest: { ...prepared.manifest, sha256: 'a'.repeat(64) } })).toThrow('DIGEST')
  })
  it('never releases a reconstructed request after caller cancellation, including after complete upload', () => {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects), controller = new AbortController(), sink = receiver(prepared, controller.signal)
    for (const part of prepared.fragments()) sink.append(part)
    controller.abort(new Error('ORIGINAL_TOTAL_DEADLINE'))
    expect(() => sink.reconstructForFinalAuthorization()).toThrow('ORIGINAL_TOTAL_DEADLINE')
    expect(() => sink.append([...prepared.fragments()][0])).toThrow('ORIGINAL_TOTAL_DEADLINE')
  })
  it('requires the complete original fields and does not admit a mixed effect array', () => {
    expect(() => prepareStagedRequestDocuments({ ...simple(), changes: [] }, binding, effects)).toThrow('SEPARATE_BOUND_STREAM')
    const { compensation: _omitted, ...request } = simple()
    expect(() => prepareStagedRequestDocuments(request, binding, effects)).toThrow('MISSING')
    expect(() => prepareStagedRequestDocuments({ ...simple(), commandId: 'different' }, binding, effects)).toThrow('BINDING_MISMATCH')
  })
})

describe('provisional upload transport, not a command commit or replay endpoint', () => {
  function fixture() {
    const prepared = prepareStagedRequestDocuments(simple(), binding, effects), sink = receiver(prepared)
    const offsets: Record<StagedDocumentName, number> = { metadata: 0, beforeEnvelope: 0, afterEnvelope: 0, compensation: 0 }
    const begin = vi.fn(async (input: { manifestWire: string; manifestSha256: string }, _signal: AbortSignal) => {
      expect(input).toEqual({ manifestWire: prepared.manifestWire, manifestSha256: prepared.manifest.sha256 })
      return { stageId: binding.stageId, manifestSha256: prepared.manifest.sha256, completed: false, nextOffsets: { ...offsets } }
    })
    const append = vi.fn<StagedDocumentTransport['append']>(async part => {
      const ack = sink.append(part); offsets[part.document] = ack.nextOffset
      return { stageId: binding.stageId, manifestSha256: prepared.manifest.sha256, ...ack }
    })
    return { prepared, sink, offsets, transport: { begin, append } }
  }
  it('uses the exact original total signal on every request and never exposes a receipt', async () => {
    const f = fixture(), signal = new AbortController().signal
    const result = await uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })
    expect(result).toEqual({ stageId: binding.stageId, manifestSha256: f.prepared.manifest.sha256, requiresFinalAuthorization: true, previouslyCompleted: false })
    for (const call of [...f.transport.begin.mock.calls, ...f.transport.append.mock.calls]) expect(call[1]).toBe(signal)
    expect(f.sink.reconstructForFinalAuthorization()).toEqual(simple())
  })
  it('resumes an ambiguous append only with the same immutable manifest, without automatic retries', async () => {
    const f = fixture(), signal = new AbortController().signal, original = f.transport.append.getMockImplementation()!
    f.transport.append.mockImplementationOnce(async (part, sameSignal) => { await original(part, sameSignal); throw Error('LOST_APPEND_RESPONSE') })
    await expect(uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })).rejects.toThrow('LOST_APPEND_RESPONSE')
    expect(f.transport.begin).toHaveBeenCalledTimes(1); expect(f.transport.append).toHaveBeenCalledTimes(1)
    expect(() => f.sink.reconstructForFinalAuthorization()).toThrow('INCOMPLETE')
    await uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })
    expect(f.transport.begin).toHaveBeenCalledTimes(2)
    expect(f.transport.append).toHaveBeenCalledTimes([...f.prepared.fragments()].length)
    expect(f.sink.reconstructForFinalAuthorization()).toEqual(simple())
  })
  it('does not turn completed stage status into authorization or reupload completed bytes', async () => {
    const f = fixture(), signal = new AbortController().signal
    await uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })
    f.transport.append.mockClear()
    f.transport.begin.mockResolvedValue({ stageId: binding.stageId, manifestSha256: f.prepared.manifest.sha256, completed: true, nextOffsets: { ...f.offsets } })
    expect(await uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })).toMatchObject({ requiresFinalAuthorization: true, previouslyCompleted: true })
    expect(f.transport.append).not.toHaveBeenCalled()
  })
  it('stops at cancellation after an acknowledged page without allocating a fresh deadline', async () => {
    const f = fixture(), controller = new AbortController(), original = f.transport.append.getMockImplementation()!
    f.transport.append.mockImplementationOnce(async (part, signal) => { const ack = await original(part, signal); controller.abort(new Error('TOTAL_DEADLINE')); return ack })
    await expect(uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal: controller.signal })).rejects.toThrow('TOTAL_DEADLINE')
    expect(f.transport.append).toHaveBeenCalledTimes(1)
  })
  it('refuses invalid resume cursor, leaked cached receipt and a mismatched acknowledgement', async () => {
    const f = fixture(), signal = new AbortController().signal
    f.transport.begin.mockResolvedValueOnce({ stageId: binding.stageId, manifestSha256: f.prepared.manifest.sha256, completed: false, nextOffsets: { ...f.offsets, metadata: 1 } })
    await expect(uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })).rejects.toThrow('CURSOR')
    f.transport.begin.mockImplementationOnce(async () => ({ stageId: binding.stageId, manifestSha256: f.prepared.manifest.sha256, completed: false, nextOffsets: { ...f.offsets }, receipt: {} }))
    await expect(uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })).rejects.toThrow('STATUS')
    f.transport.append.mockResolvedValueOnce({ stageId: 'foreign', manifestSha256: f.prepared.manifest.sha256, document: 'metadata', nextOffset: 1 })
    await expect(uploadStagedRequestDocuments({ prepared: f.prepared, transport: f.transport, signal })).rejects.toThrow('ACK')
  })
})

describe('actual original command payload evidence, not an effect-count heuristic', () => {
  it('preserves a legal one-effect Planning command larger than the unchanged 2 MiB fast path, and original Undo', async () => {
    const f = await largePlanningFixture(), staged = prepareStagedEffects(f.delta)
    expect(f.delta.changes).toHaveLength(1); expect(f.undoDelta.changes).toHaveLength(0)
    for (const value of [f.before.data.decisionRules, f.before.data.discoveryProfile, f.before.data.timePlanning]) expect(Buffer.byteLength(JSON.stringify(value))).toBe(262_100)
    expect(Buffer.byteLength(JSON.stringify({ ...f.delta, compensation: f.result.compensation }))).toBe(2_098_867)
    const request = { ...staged.metadata, ...identity(), compensation: f.result.compensation, provenance: { original: true } }
    const prepared = prepareStagedRequestDocuments(request, binding, { ...effects, count: staged.parts.length, sha256: staged.finalDigest })
    const sink = receiver(prepared); for (const part of prepared.fragments()) sink.append(part)
    expect(sink.reconstructForFinalAuthorization()).toEqual(request)
    expect(f.undo.data.timePlanning).toEqual(f.before.data.timePlanning)
    expect(f.undo.data.decisionRules).toEqual(f.before.data.decisionRules)
    expect(f.undo.data.discoveryProfile).toEqual(f.before.data.discoveryProfile)
    expect(f.undo.data.timeline).toEqual(f.result.snapshot.data.timeline)
    const fetchImpl = vi.fn()
    const rows = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    await expect(rows.commitPlanning({ workspaceId, userId, epoch: expectedEpoch, revision: 0, snapshot: f.before }, f.result.snapshot, {
      commandId: binding.commandId, payloadHash: binding.payloadHash, compensation: f.result.compensation,
      grantId: String(binding.authority.grantId), grantRevision: 3, clientId: 'synthetic-client',
    })).rejects.toMatchObject({ code: 'INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('takes the complete V5 receiptContext from the real handler/core and preserves it without a V2 substitution', async () => {
    for (const key of ['PJSDAS_WORKSPACE_ROWS_READS', 'PJSDAS_WORKSPACE_ROWS_WRITES', 'PJSDAS_GMAIL_EMPTY_CHECKPOINTS', 'PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS']) vi.stubEnv(key, '0')
    vi.stubEnv('PJSDAS_WORKSPACE_COMMIT_METADATA_ONLY', '1'); vi.stubEnv('PJSDAS_WORKSPACE_COMMIT_RAW_JSON', '1')
    const f = largeAbandonFixture(), origin = 'https://synthetic.invalid'
    let captured: Record<string, any> | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/auth/v1/user') return Response.json({ id: userId })
      if (path === '/rest/v1/rpc/pjsdas_read_legacy_workspace_v1') return Response.json([{ id: workspaceId, user_id: userId, revision: 0, schema_version: 4, snapshot: f.before }])
      if (path === '/rest/v1/pjsdas_command_ledger') return Response.json([])
      if (path === '/rest/v1/rpc/pjsdas_commit_workspace_v4') {
        captured = JSON.parse(String(init?.body))
        return Response.json([{ outcome: 'COMMITTED', workspace_id: workspaceId, revision: 1, receipt: { ...captured!.target_receipt_context,
          commandId: captured!.target_command_id, receiptId: `command-receipt:${captured!.target_command_id}`, operation: captured!.target_operation,
          status: 'COMMITTED', revision: 1, undoAvailable: true } }])
      }
      throw Error(`UNEXPECTED_SYNTHETIC_REQUEST:${path}`)
    }
    const handler = createConnectedWorkspaceHandler({ supabaseUrl: origin, supabasePublishableKey: 'synthetic', serviceRoleKey: 'synthetic', allowedOrigins: [origin], fetchImpl })
    const response = await handler(new Request(origin + '/api/workspace', { method: 'POST', headers: { origin, authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'command', projection: 'delta-v1', commandId: f.command.commandId, baseRevision: 0, command: { type: 'domain', value: f.command } }) }))
    expect(response.status).toBe(200); expect(captured).toBeDefined()
    const full = captured!, result = await response.json()
    expect(full.target_receipt_context.contractVersion).toBe(5)
    for (const name of ['projectionDelta', 'affectedObjects', 'affectedFields', 'conflictScopes', 'undoDependencyObjects', 'readModelInvalidation', 'lifecycle', 'result']) expect(full.target_receipt_context).toHaveProperty(name)
    const staged = prepareStagedEffects(diffReadableWorkspaceRows(f.before, full.target_snapshot))
    const context: StagedRequestBinding = { ...binding, family: 'first_party_abandon', commandId: full.target_command_id, payloadHash: full.target_payload_hash,
      operation: full.target_operation, principal: full.target_principal_kind, authority: {} }
    const request = { ...staged.metadata, ...identity(context), compensation: full.target_compensation,
      receiptContext: full.target_receipt_context, provenance: full.target_provenance, effectiveTime: full.target_effective_time }
    expect(staged.parts).toHaveLength(2102)
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(1_048_576)
    const prepared = prepareStagedRequestDocuments(request, context, { ...effects, count: staged.parts.length, sha256: staged.finalDigest })
    const sink = receiver(prepared); for (const part of prepared.fragments()) sink.append(part)
    const reconstructed = sink.reconstructForFinalAuthorization()
    expect(reconstructed).toEqual(request)
    expect(reconstructed.receiptContext).toEqual(full.target_receipt_context)
    expect(reconstructed.compensation).toEqual(full.target_compensation)
    // HTTP delta mode moves this field to result.delta; the persisted receipt
    // must still retain it, rather than substituting the compact HTTP receipt.
    for (const [key, value] of Object.entries(full.target_receipt_context)) expect(key === 'projectionDelta' ? result.delta : result.receipt[key]).toEqual(value)
    expect(createHash('sha256').update(JSON.stringify(reconstructed.receiptContext)).digest('hex')).toBe(createHash('sha256').update(JSON.stringify(full.target_receipt_context)).digest('hex'))
  })
})
