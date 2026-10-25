import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceRowsCandidate } from '../gateway/workspaceRowsCandidate'
import { encodeWorkspaceRows } from '../gateway/workspaceRowsCodec'
import { createSnapshot } from '../src/snapshot'

const userId = '11111111-1111-1111-1111-111111111111', workspaceId = '22222222-2222-2222-2222-222222222222', epoch = '33333333-3333-3333-3333-333333333333'
const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }, '2030-01-01T00:00:00Z')
const encoded = encodeWorkspaceRows(snapshot)
const head = { workspaceId, userId, epoch, revision: 0, format: 'workspace-rows-v1', envelope: encoded.envelope, manifest: encoded.manifest }
const page = { outcome: 'PAGE', workspaceId, epoch, revision: 0, rows: encoded.rows, end: true }
const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const command = { operation: 'gmail_semantic_intake' as const, principal: 'automation' as const, sourceId: 'gmail:primary' as const, commandId: 'synthetic-command', payloadHash: 'a'.repeat(64), compensation: {} }
const before = { workspaceId, userId, epoch, revision: 0, snapshot }
function mock(values: unknown[]) {
  const fetchImpl = vi.fn(async () => respond(values.shift()))
  return { fetchImpl, source: createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic-local-token', readsEnabled: true, fetchImpl }) }
}

describe('Stage A row adapter fail-closed contract', () => {
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
  it('preserves an immutable planning receipt after a valid regrant replay', async () => {
    const grantId = '55555555-5555-5555-5555-555555555555'
    const receipt = { commandId: 'synthetic-planning', operation: 'planning_management', status: 'COMMITTED', revision: 1, managementAuthorization: { grantId, grantRevision: 1, consentVersion: 4 } }
    const fetchImpl = vi.fn(async () => respond({ outcome: 'ALREADY_APPLIED', revision: 1, receipt }))
    const writer = createWorkspaceRowsCandidate({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', readsEnabled: true, writesEnabled: true, fetchImpl })
    const input = { commandId: 'synthetic-planning', payloadHash: 'b'.repeat(64), compensation: {}, grantId, grantRevision: 3, clientId: userId }
    expect((await writer.commitPlanning(before, snapshot, input)).receipt).toEqual(receipt)
    fetchImpl.mockImplementation(async () => respond({ outcome: 'COMMITTED', revision: 1, receipt }))
    await expect(writer.commitPlanning(before, snapshot, input)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(writer.commitPlanning(before, snapshot, { ...input, operation: 'undo_command' })).rejects.toMatchObject({ code: 'INVALID' })
  })

})
