import { describe, expect, it } from 'vitest'
import { hashMutationPayload } from '../gateway/mutationKernel.js'
import { invokeAddOpportunities } from '../gateway/addOpportunities.js'
import { createSnapshot } from '../src/snapshot.js'
import { applySemanticCompensation } from '../src/semanticIntake.js'
import { WorkspaceSourceError, type GatewayWorkspace, type WorkspaceWriteInput, type WorkspaceSource } from '../gateway/workspaceSource.js'
import { discoveryReceiptFixture } from './fixtures/verifiedDiscovery.js'

const at = '2026-10-07T20:00:00.000Z'
const input = { commandId: 'explicit-b2-receipt-001', opportunities: [{ company: 'Synthetic Company', role: 'Product Manager' }] }
class Source implements WorkspaceSource {
  snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [], changeSets: [] }, at)
  revision = 1
  writes: WorkspaceWriteInput[] = []
  receipts = new Map<string, NonNullable<ReturnType<typeof discoveryReceiptFixture>>>()
  afterCommitReadFailure = false
  afterCommitLedgerFailure = false
  conflictOnce = false
  lostAcknowledgement = false
  undoBeforeReadback = false
  response: 'normal'|'already'|'wrong-receipt' = 'normal'
  async read(): Promise<GatewayWorkspace> {
    if (this.undoBeforeReadback && this.writes.length && this.snapshot.data.opportunities.length) {
      this.snapshot = applySemanticCompensation(this.snapshot, this.writes[0].command!.compensation as any, new Date('2026-10-07T21:00:00Z'))
      this.revision += 1
    }
    if (this.afterCommitReadFailure && this.writes.length) throw new Error('Synthetic readback unavailable')
    return { snapshot: structuredClone(this.snapshot), context: { now: new Date(at), workspaceVersion: `txn:${this.revision}` } }
  }
  async readCommandReceipt(commandId: string) {
    if (this.afterCommitLedgerFailure && this.writes.length) throw new Error('Synthetic ledger unavailable')
    return this.receipts.get(commandId) ?? null
  }
  async write(value: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    if (this.conflictOnce) { this.conflictOnce = false; this.revision += 1; throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Synthetic concurrent revision', true) }
    expect(value.expectedWorkspaceVersion).toBe(`txn:${this.revision}`)
    this.writes.push(value); this.snapshot = structuredClone(value.snapshot); this.revision += 1
    const receipt = discoveryReceiptFixture(value, this.revision)!
    this.receipts.set(value.command!.commandId, receipt)
    if (this.lostAcknowledgement) throw new Error('Synthetic lost write acknowledgement')
    return { snapshot: structuredClone(this.snapshot), context: { now: new Date(at), workspaceVersion: `txn:${this.revision}` },
      commandOutcome: this.response === 'already' ? 'ALREADY_APPLIED' : 'COMMITTED',
      commandReceipt: this.response === 'wrong-receipt' ? { ...receipt.receipt, commandId: 'another-command' } : receipt.receipt }
  }
}
const body = (result: Awaited<ReturnType<typeof invokeAddOpportunities>>) => result.structuredContent as any

describe('B2 explicit user job receipt truth', () => {
  it('returns a joined command receipt and original operation time without new objects or times on replay', async () => {
    const source = new Source()
    const first = await invokeAddOpportunities(source, input)
    expect(body(first)).toMatchObject({ applied: true, createdCount: 1, durableCommit: true, readbackVerified: true, commandReceipt: { revision: 2 } })
    const before = structuredClone(source.snapshot)
    const replay = await invokeAddOpportunities(source, input)
    expect(body(replay)).toMatchObject({ alreadyApplied: true, createdCount: 0, duplicateCount: 1, durableCommit: true, readbackVerified: true,
      originalOperationTime: body(first).originalOperationTime, commandReceipt: body(first).commandReceipt })
    expect(source.snapshot).toEqual(before); expect(source.writes).toHaveLength(1)
  })
  it('replays an exact legacy canonical input across tracking variants only with the original affected semantic receipt', async () => {
    const source = new Source()
    const initial = { commandId: input.commandId, opportunities: [{ ...input.opportunities[0], sourceUrl: 'https://example.test/jobs/1?utm_source=old' }] }
    await invokeAddOpportunities(source, initial)
    const old = source.receipts.get(input.commandId)!
    old.payloadHash = await hashMutationPayload('add_opportunities', initial)
    old.receipt = { ...old.receipt, contractVersion: 2, commandType: 'workspace_source_semantic',
      affectedObjects: [{ type: 'semantic_receipt', id: source.snapshot.data.semanticReceipts![0].id }] }
    const preserved = structuredClone(old)
    const changedTracking = { ...initial, opportunities: [{ ...initial.opportunities[0], sourceUrl: 'https://example.test/jobs/1?utm_source=new' }] }
    const replay = await invokeAddOpportunities(source, changedTracking)
    expect(replay.isError).not.toBe(true); expect(body(replay)).toMatchObject({ alreadyApplied: true, createdCount: 0, commandReceipt: preserved.receipt })
    expect(source.receipts.get(input.commandId)).toEqual(preserved); expect(source.writes).toHaveLength(1)
    source.revision += 1
    expect(body(await invokeAddOpportunities(source, changedTracking)).code).toBe('COMMAND_ID_REUSED')
    expect((await invokeAddOpportunities(source, initial)).isError).not.toBe(true)
    source.revision -= 1
    expect(body(await invokeAddOpportunities(source, { ...changedTracking, opportunities: [{ ...changedTracking.opportunities[0], deadline: '2026-11-01' }] })).code).toBe('COMMAND_ID_REUSED')
    old.receipt = { ...old.receipt, affectedObjects: [{ type: 'semantic_receipt', id: 'unrelated-receipt' }] }
    expect(body(await invokeAddOpportunities(source, changedTracking)).code).toBe('COMMAND_ID_REUSED')
  })
  it('replays the deterministic domain step after a CAS conflict, without extra business writes', async () => {
    const source = new Source(); source.conflictOnce = true
    const result = await invokeAddOpportunities(source, input)
    expect(result.isError).not.toBe(true); expect(body(result)).toMatchObject({ createdCount: 1, workspaceVersion: 'txn:3', readbackVerified: true })
    expect(source.writes).toHaveLength(1); expect(source.snapshot.data.opportunities).toHaveLength(1)
    expect(source.snapshot.data.actions).toEqual([]); expect(source.snapshot.data.scheduleNodes).toEqual([])
  })
  it('recovers a lost acknowledgement from the same authoritative receipt without creating again', async () => {
    const source = new Source(); source.lostAcknowledgement = true
    const result = await invokeAddOpportunities(source, input)
    expect(result.isError).not.toBe(true); expect(body(result)).toMatchObject({ alreadyApplied: true, createdCount: 0, durableCommit: true, readbackVerified: true })
    expect(source.writes).toHaveLength(1)
  })
  it.each(['afterCommitReadFailure','afterCommitLedgerFailure'] as const)('an acknowledged commit remains committed when %s prevents independent verification', async flag => {
    const source = new Source(); source[flag] = true
    const result = await invokeAddOpportunities(source, input)
    expect(result.isError).not.toBe(true); expect(body(result)).toMatchObject({ createdCount: 1, durableCommit: true, readbackVerified: false })
    expect(body(result).verificationWarning).toContain('pending'); expect(source.writes).toHaveLength(1)
  })
  it('does not report local pre-write counts as a fresh creation when the backend returns the original receipt', async () => {
    const source = new Source(); source.response = 'already'
    const result = await invokeAddOpportunities(source, input)
    expect(result.isError).not.toBe(true); expect(body(result)).toMatchObject({ createdCount: 0, duplicateCount: 1, alreadyApplied: true })
  })
  it('rejects a mismatched write receipt and a marker-only transactional replay', async () => {
    const source = new Source(); source.response = 'wrong-receipt'
    expect(body(await invokeAddOpportunities(source, input)).code).toBe('OPPORTUNITY_RECEIPT_MISMATCH')
    source.receipts.clear()
    expect(body(await invokeAddOpportunities(source, input)).code).toBe('OPPORTUNITY_COMMIT_UNVERIFIED')
    expect(source.writes).toHaveLength(1)
  })
  it.each([false, true])('a concurrent Undo before readback is reflected even after a lost acknowledgement (%s)', async lostAcknowledgement => {
    const source = new Source(); source.undoBeforeReadback = true; source.lostAcknowledgement = lostAcknowledgement
    const result = await invokeAddOpportunities(source, input)
    expect(result.isError).not.toBe(true)
    expect(body(result)).toMatchObject({ applied: false, createdCount: 0, durableCommit: true, readbackVerified: true })
    expect(source.snapshot.data.opportunities).toEqual([]); expect(source.writes).toHaveLength(1)
  })
  it('an undone command ID never silently recreates the job or changes the original receipt', async () => {
    const source = new Source()
    const first = await invokeAddOpportunities(source, input)
    const original = source.receipts.get(input.commandId)
    source.snapshot = applySemanticCompensation(source.snapshot, source.writes[0].command!.compensation as any, new Date('2026-10-07T21:00:00Z'))
    source.revision += 1
    const replay = await invokeAddOpportunities(source, input)
    expect(body(replay)).toMatchObject({ applied: false, alreadyApplied: true, createdCount: 0, commandReceipt: body(first).commandReceipt })
    expect(source.snapshot.data.opportunities).toEqual([]); expect(source.receipts.get(input.commandId)).toEqual(original); expect(source.writes).toHaveLength(1)
  })
})
