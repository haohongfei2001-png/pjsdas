import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceRowsCandidate } from '../gateway/workspaceRowsCandidate'
import { encodeWorkspaceRows } from '../gateway/workspaceRowsCodec'
import { createSnapshot } from '../src/snapshot'

const userId = '11111111-1111-1111-1111-111111111111', workspaceId = '22222222-2222-2222-2222-222222222222', epoch = '33333333-3333-3333-3333-333333333333'
const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }, '2030-01-01T00:00:00Z')
const encoded = encodeWorkspaceRows(snapshot)
const head = { workspaceId, userId, epoch, revision: 0, schemaVersion: 4, format: 'workspace-rows-v1', envelope: encoded.envelope, manifest: encoded.manifest }
const page = { outcome: 'PAGE', workspaceId, epoch, revision: 0, rows: encoded.rows, end: true }
const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const command = { operation: 'gmail_semantic_intake' as const, principal: 'automation' as const, sourceId: 'gmail:primary' as const, commandId: 'synthetic-command', payloadHash: 'a'.repeat(64), compensation: {} }
const before = { workspaceId, userId, epoch, revision: 0, snapshot }
function mock(values: unknown[]) {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => respond(values.shift()))
  return { fetchImpl, source: createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic-local-token', readsEnabled: true, fetchImpl }) }
}

describe('Stage A row adapter fail-closed contract', () => {
  it('uses versioned public-schema RPC transport without exposing the candidate schema', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => respond(head))
    const source = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid/', serviceRoleKey: 'synthetic', readsEnabled: true, rpcTransport: 'public-v1', fetchImpl })
    expect((await source.readIdentity(userId))?.revision).toBe(0)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://synthetic.invalid/rest/v1/rpc/pjsdas_rows_v1_read_head')
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('content-profile')).toBe('public')
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('accept-profile')).toBe('public')
    expect(() => createWorkspaceRowsCandidate({ supabaseUrl: '', serviceRoleKey: '', rpcTransport: 'unknown' as never })).toThrow('INVALID')
  })
  it('bounds header-only projection and propagates a caller deadline', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(init?.signal).toBeDefined(); expect(init?.signal?.aborted).toBe(true); throw new Error('aborted') })
    const source = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, fetchImpl })
    controller.abort()
    await expect(source.readDiscoveryProfile(userId, controller.signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(mock([{ ...head, envelope: { ...head.envelope, oversized: 'x'.repeat(1_048_576) } }]).source.readDiscoveryProfile(userId)).rejects.toMatchObject({ code: 'INVALID' })
  })
  it.each([[409, '23505', 'COMMAND_ID_REUSED', false], [403, '42501', 'FORBIDDEN', false], [400, '22023', 'INVALID', false], [409, 'PT409', 'CONFLICT', true], [503, '08006', 'UNAVAILABLE', true]] as const)('keeps database failure %s/%s distinct from retryable CAS', async (status, code, expected, retryable) => {
    const source = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, fetchImpl: async () => new Response(JSON.stringify({ code, message: 'Never forwarded' }), { status }) })
    await expect(source.readIdentity(userId)).rejects.toMatchObject({ code: expected, retryable })
  })

  it('fences history across pages and final head rather than returning mixed command evidence', async () => {
    const value = { outcome: 'HISTORY', workspaceId, userId, epoch, revision: 0, rows: [] }
    const stable = mock([head, value, head])
    expect((await stable.source.readHistory(userId, epoch, { mode: 'command', commandId: 'synthetic' })).rows).toEqual([])
    for (const values of [[head, value, { ...head, revision: 1 }], [head, { outcome: 'CONFLICT' }], [head, value, null]]) {
      await expect(mock(values).source.readHistory(userId, epoch, { mode: 'after', afterRevision: 0 })).rejects.toMatchObject({ code: 'CONFLICT' })
    }
    await expect(mock([head, { ...value, rows: [{ user_id: workspaceId, workspace_id: workspaceId, command_id: 'synthetic', resulting_revision: 0 }] }]).source.readHistory(userId, epoch, { mode: 'command', commandId: 'synthetic' })).rejects.toMatchObject({ code: 'INVALID' })
  })
  it('rejects a repeated command at a history page boundary instead of skipping it', async () => {
    const newer = { ...head, revision: 260 }
    const rows = Array.from({ length: 128 }, (_, i) => ({ user_id: userId, workspace_id: workspaceId, command_id: `synthetic-${i + 1}`, resulting_revision: i + 1 }))
    const value = { outcome: 'HISTORY', workspaceId, userId, epoch, revision: 260, rows }
    const source = mock([newer, value, { ...value, rows: [rows[126]] }]).source
    await expect(source.readHistory(userId, epoch, { mode: 'after', afterRevision: 0 })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('continues byte-bounded command history without dropping a short page or repeating identities', async () => {
    const h = { ...head, revision: 2 }
    const row = (n: number) => ({ user_id: userId, workspace_id: workspaceId, command_id: `synthetic-${n}`, resulting_revision: n })
    const history = { outcome: 'HISTORY', workspaceId, userId, epoch, revision: 2 }
    const { source, fetchImpl } = mock([h, { ...history, rows: [row(1)], hasMore: true }, { ...history, rows: [row(2)], hasMore: false }, h])
    expect((await source.readHistory(userId, epoch, { mode: 'after', afterRevision: 0 })).rows).toEqual([row(1), row(2)])
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body)).query).toMatchObject({ cursorRevision: 1, cursorCommand: 'synthetic-1' })
    await expect(mock([h, { ...history, rows: [], hasMore: true }]).source.readHistory(userId, epoch, { mode: 'after', afterRevision: 0 })).rejects.toMatchObject({ code: 'INVALID' })
  })
  it('does not return paged history from a changed final revision', async () => {
    const history = { outcome: 'HISTORY', workspaceId, userId, epoch, revision: 0, rows: [], hasMore: false }
    await expect(mock([head, history, { ...head, revision: 1 }]).source.readHistory(userId, epoch, { mode: 'after', afterRevision: 0 })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('has no network activity with default-off options', async () => {
    const fetchImpl = vi.fn(); const source = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl })
    await expect(source.read(userId)).rejects.toMatchObject({ code: 'DISABLED' }); expect(fetchImpl).not.toHaveBeenCalled()
    expect(() => createWorkspaceRowsCandidate({ supabaseUrl: '', serviceRoleKey: '', writesEnabled: true })).toThrow('DISABLED')
  })
  it('preserves exact validated snapshot with matching fences', async () => {
    const { source } = mock([head, page, head]); expect(await source.read(userId)).toEqual(before)
  })
  it.each([{ ...head, revision: 1 }, { ...head, epoch: '44444444-4444-4444-4444-444444444444' }, null])('rejects changed/absent final head', async final => {
    const { source } = mock([head, page, final]); await expect(source.read(userId)).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
  })
  it.each([{ ...head, userId: workspaceId }, { ...head, format: 'unknown' }, { ...head, revision: -1 }])('rejects malformed initial identity/layout', async invalid => {
    const { source } = mock([invalid]); await expect(source.read(userId)).rejects.toMatchObject({ code: 'INVALID' })
  })
  it.each([{ ...page, end: false }, { ...page, epoch: workspaceId }, { ...page, rows: [{ collection: 'opportunities', id: 1, ordinal: 0, value: { id: 1 } }] }])('rejects incomplete or malformed page without fallback', async invalid => {
    const { source } = mock([head, invalid, head]); await expect(source.read(userId)).rejects.toMatchObject({ code: 'INVALID' })
  })
  it('continues a nonempty byte-full short page with the exact keyset cursor', async () => {
    const value = createSnapshot({ ...snapshot.data, timeline: [0, 1].map(i => ({ id: `synthetic-byte:${i}`, kind: 'baseline_backfill' as const, category: 'data' as const, source: 'system' as const, occurredAt: snapshot.exportedAt, recordedAt: snapshot.exportedAt, title: 'Synthetic byte page' })) }, snapshot.exportedAt)
    const encodedValue = encodeWorkspaceRows(value)
    const expectedHead = { ...head, envelope: encodedValue.envelope, manifest: encodedValue.manifest }
    const { source, fetchImpl } = mock([expectedHead, { ...page, rows: encodedValue.rows.slice(0, 1), end: false }, { ...page, rows: encodedValue.rows.slice(1), end: true }, expectedHead])
    expect((await source.read(userId))?.snapshot).toEqual(value)
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toMatchObject({ after_collection: 'timeline', after_ordinal: 0 })
  })
  it('does not silently retry page conflict', async () => {
    const { source, fetchImpl } = mock([head, { outcome: 'CONFLICT' }]); await expect(source.read(userId)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('keeps writer switch separate and rejects all unadapted guarded credentials', async () => {
    const fetchImpl = vi.fn(); const source = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, fetchImpl })
    await expect(source.commit(before, snapshot, command)).rejects.toMatchObject({ code: 'DISABLED' })
    const writer = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    for (const key of ['managementAuthorization', 'aiCaptureAuthorization', 'discoveryAuthorization']) await expect(writer.commit(before, snapshot, { ...command, [key]: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(writer.commit(before, snapshot, { ...command, changes: [] } as typeof command)).rejects.toMatchObject({ code: 'INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('rejects receipt revision mismatch rather than echoing an unverified snapshot', async () => {
    const fetchImpl = vi.fn(async () => respond({ outcome: 'COMMITTED', revision: 1, receipt: { commandId: command.commandId, operation: command.operation, status: 'COMMITTED', revision: 0 } }))
    const writer = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    await expect(writer.commit(before, snapshot, command)).rejects.toMatchObject({ code: 'INVALID' })
  })
  it.each([['commitPlanning', 'planning_management', 4], ['commitDiscoveryProfile', 'discovery_profile_management', 5], ['commitPrivateReminder', 'private_reminder_management', 6], ['commitOpportunity', 'opportunity_management', 3], ['commitBusiness', 'business_management', 7], ['commitLegacyManagement', 'business_management', 2]] as const)('preserves immutable %s receipt after valid regrant replay', async (method, operation, consentVersion) => {
    const grantId = '55555555-5555-5555-5555-555555555555'
    const receipt = { commandId: 'synthetic-planning', operation, status: 'COMMITTED', revision: 1, managementAuthorization: { grantId, grantRevision: 1, consentVersion } }
    const fetchImpl = vi.fn(async () => respond({ outcome: 'ALREADY_APPLIED', revision: 1, receipt }))
    const writer = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    const input = { commandId: 'synthetic-planning', payloadHash: 'b'.repeat(64), compensation: {}, grantId, grantRevision: 3, clientId: userId }
    expect((await writer[method](before, snapshot, input)).receipt).toEqual(receipt)
    fetchImpl.mockImplementation(async () => respond({ outcome: 'COMMITTED', revision: 1, receipt }))
    await expect(writer[method](before, snapshot, input)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(writer[method](before, snapshot, { ...input, operation: 'undo_command' })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('keeps capture admission and confirmation off by default and rejects authority injection', async () => {
    const fetchImpl = vi.fn()
    const disabled = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl })
    const admission = { requestId: 'synthetic-request', payloadHash: 'a'.repeat(64), text: 'Synthetic task', timezone: 'UTC', referenceTime: '2030-01-01T00:00:00Z', reservationUnits: 1 }
    const capture = { commandId: 'synthetic-capture', payloadHash: 'a'.repeat(64), requestId: admission.requestId, observation: {}, compensation: {} }
    await expect(disabled.admitCapture(before, admission)).rejects.toMatchObject({ code: 'DISABLED' })
    await expect(disabled.commitCapture(before, snapshot, capture)).rejects.toMatchObject({ code: 'DISABLED' })
    const enabled = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    await expect(enabled.commitCapture(before, snapshot, { ...capture, managementAuthorization: {} } as typeof capture)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(enabled.admitCapture(before, { ...admission, reservationUnits: 0 })).rejects.toMatchObject({ code: 'INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves trusted command audit context while keeping fixed authority fields', async () => {
    const receipt = { commandId: command.commandId, operation: command.operation, status: 'COMMITTED', revision: 1, undoAvailable: true }
    const fetchImpl = vi.fn(async () => respond({ outcome: 'COMMITTED', revision: 1, receipt }))
    const writer = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    const audit = { provenance: { runId: 'synthetic-run', sourceId: 'gmail:primary' }, effectiveTime: '2030-01-01T00:00:00Z', receiptContext: { contractVersion: 2, affectedObjects: [{ type: 'timeline', id: 'synthetic-audit' }], lifecycle: { rebased: false } } }
    await writer.commit(before, snapshot, { ...command, ...audit })
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string)
    expect(body.req).toMatchObject({ ...audit, principal: 'automation', schemaVersion: snapshot.version })
  })

  it('keeps Discovery claims off by default and rejects unrecognized writer authority', async () => {
    const fetchImpl = vi.fn()
    const disabled = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl })
    const discovery = { commandId: 'synthetic-claim', payloadHash: 'a'.repeat(64), operation: 'checkpoint_discovery_search' as const, principal: 'automation' as const, provenance: {}, compensation: null, authorization: {} }
    await expect(disabled.commitDiscovery(before, snapshot, discovery)).rejects.toMatchObject({ code: 'DISABLED' })
    const enabled = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    await expect(enabled.commitDiscovery(before, snapshot, { ...discovery, managementAuthorization: {} } as typeof discovery)).rejects.toMatchObject({ code: 'INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

})
