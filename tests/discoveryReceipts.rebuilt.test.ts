import { describe, expect, it } from 'vitest'
import { commitVerifiedDiscoveryRun } from '../gateway/verifiedDiscoveryCommit.js'
import { discoveryCommandRun } from '../src/verifiedDiscoveryCommand.js'
import { AT, AUTOMATION, LedgerHarness, SOURCE, clone, command } from './fixtures/b2Ledger.rebuilt.js'

describe('B2 rebuilt automatic command receipts (offline, new coverage)', () => {
  it('joins the original ID, hash, revision and server time, preserving them on replay', async () => {
    const db = new LedgerHarness(), value = await command()
    const first = await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    expect(first).toMatchObject({ durableCommit: true, readbackVerified: true, commandId: value.commandId, receipt: {
      receiptId: `command-receipt:${value.commandId}`, revision: 2, committedAt: AT } })
    expect(first.result.createdOpportunityIds).toHaveLength(1)
    const saved = clone(db.snapshot), row = clone(db.rows.get(value.commandId))
    db.now = new Date('2026-10-08T20:00:00.000Z')
    const replay = await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    expect(replay).toMatchObject({ durableCommit: true, readbackVerified: true, receipt: first.receipt, result: { alreadyApplied: true, createdOpportunityIds: [] } })
    expect(db.rows.get(value.commandId)).toEqual(row)
    expect(db.rows.get(value.commandId)?.payload_hash).toBe(value.inputFingerprint)
    expect(db.snapshot).toEqual(saved)
    expect(db.writes).toHaveLength(1); expect(db.attempts).toHaveLength(1)
    expect(db.snapshot.data.actions).toEqual([]); expect(db.snapshot.data.scheduleNodes).toEqual([])
  })

  it('reconciles a lost ACK through the original ledger without a second write', async () => {
    const db = new LedgerHarness(), value = await command(); db.lostAck = true
    const result = await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    expect(result).toMatchObject({ durableCommit: true, readbackVerified: true, result: { alreadyApplied: true, createdOpportunityIds: [] }, receipt: { revision: 2, committedAt: AT } })
    expect(db.writes).toHaveLength(1); expect(db.attempts).toHaveLength(1); expect(db.rows.size).toBe(1)
    expect(db.snapshot.data.opportunities).toHaveLength(1)
  })

  it.each(['failWorkspaceAfterCommit', 'failLedgerAfterCommit'] as const)('reports committed/readback pending on %s', async flag => {
    const db = new LedgerHarness(), value = await command(); db[flag] = true
    const result = await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    expect(result).toMatchObject({ durableCommit: true, readbackVerified: false, receipt: { revision: 2, committedAt: AT } })
    expect(result.verificationWarning).toContain('pending')
    expect(result.result.createdOpportunityIds).toHaveLength(1)
    expect(db.snapshot.data.opportunities).toHaveLength(1); expect(db.writes).toHaveLength(1)
  })

  it.each([
    ['command ID', { commandId: 'foreign-command' }], ['receipt ID', { receiptId: 'foreign-receipt' }],
    ['operation', { operation: 'SnapshotWrite' }], ['status', { status: 'PENDING' }], ['revision', { revision: 1 }],
  ])('rejects a mismatched commit response %s', async (_label, change) => {
    const db = new LedgerHarness(), value = await command()
    db.responseTransform = response => ({ ...response, receipt: { ...response.receipt as object, ...change } })
    await expect(commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })).rejects.toMatchObject({ code: 'DISCOVERY_RECEIPT_MISMATCH' })
    expect(db.writes).toHaveLength(1); expect(db.rows.get(value.commandId)?.receipt.commandId).toBe(value.commandId)
  })

  it('rejects a fake COMMITTED outcome carrying an older real receipt', async () => {
    const db = new LedgerHarness(), loser = await command({ company: 'Losing Company' })
    const winner = await command({ company: 'Winning Company', at: '2026-10-07T19:00:00.000Z' })
    db.beforeCommit = () => { db.beforeCommit = undefined; db.seedWinner(winner, new Date('2026-10-07T19:00:00.000Z')); db.revision += 1 }
    db.responseTransform = response => ({ ...response, outcome: 'COMMITTED', revision: db.revision })
    await expect(commitVerifiedDiscoveryRun(db.source(), loser, { discoveryAuthorization: AUTOMATION })).rejects.toMatchObject({ code: 'DISCOVERY_RECEIPT_MISMATCH' })
    expect(db.writes).toEqual([]); expect(db.rows.size).toBe(1)
    expect(db.snapshot.data.opportunities[0]?.company).toBe('Winning Company')
  })

  it('uses the independent concurrent winner and its older original receipt, never the losing snapshot', async () => {
    const db = new LedgerHarness(), loser = await command({ company: 'Losing Company' })
    const winner = await command({ company: 'Winning Company', at: '2026-10-07T19:00:00.000Z' })
    let original: unknown
    db.beforeCommit = () => {
      db.beforeCommit = undefined
      original = db.seedWinner(winner, new Date('2026-10-07T19:00:00.000Z'))
      db.revision += 1 // An unrelated command advanced the workspace after the winner.
    }
    const result = await commitVerifiedDiscoveryRun(db.source(), loser, { discoveryAuthorization: AUTOMATION })
    expect(result).toMatchObject({ durableCommit: true, readbackVerified: true, workspaceVersion: 'txn:3',
      receipt: { revision: 2, committedAt: '2026-10-07T19:00:00.000Z' }, result: { alreadyApplied: true, createdOpportunityIds: [] } })
    expect(db.rows.get(winner.commandId)).toEqual(original)
    expect(db.snapshot.data.opportunities).toHaveLength(1)
    expect(db.snapshot.data.opportunities[0].company).toBe('Winning Company')
    expect(result.result.snapshot.data.opportunities[0].company).toBe('Winning Company')
    expect(db.writes).toHaveLength(0); expect(db.attempts).toHaveLength(1)
  })

  it('retries only the deterministic CAS step and carries the same command hash', async () => {
    const db = new LedgerHarness(), value = await command()
    const winner = await command({ runId: 'independent-winning-run', company: 'Independent Winning Company', postingId: '00cc7c13-0f6e-4d8d-b451-420454135014' })
    let winnerRow: unknown, winnerJob: unknown
    db.beforeCommit = () => {
      db.beforeCommit = undefined
      winnerRow = db.seedWinner(winner)
      winnerJob = clone(db.snapshot.data.opportunities[0])
    }
    const result = await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    expect(result).toMatchObject({ durableCommit: true, readbackVerified: true, workspaceVersion: 'txn:3' })
    expect(db.attempts).toHaveLength(2); expect(db.writes).toHaveLength(1)
    expect(db.attempts.map(row => [row.target_command_id, row.target_payload_hash, row.target_discovery_authorization])).toEqual([
      [value.commandId, value.inputFingerprint, AUTOMATION], [value.commandId, value.inputFingerprint, AUTOMATION],
    ])
    expect(db.snapshot.data.opportunities).toHaveLength(2)
    expect(db.snapshot.data.opportunities.find(item => item.company === 'Independent Winning Company')).toEqual(winnerJob)
    expect(db.snapshot.data.opportunities.find(item => item.company === 'Rebuilt Ledger Company')).toBeDefined()
    expect(result.result.snapshot.data.opportunities).toEqual(db.snapshot.data.opportunities)
    expect(db.rows.get(winner.commandId)).toEqual(winnerRow)
    expect(db.rows.get(value.commandId)?.resulting_revision).toBe(3)
    expect(discoveryCommandRun(db.snapshot, SOURCE, winner.run.runId)?.commandId).toBe(winner.commandId)
    expect(discoveryCommandRun(db.snapshot, SOURCE, value.run.runId)?.commandId).toBe(value.commandId)
  })

  it('does not recreate a job removed after its original command or rewrite the receipt', async () => {
    const db = new LedgerHarness(), value = await command()
    const first = await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    const row = clone(db.rows.get(value.commandId))
    // Models authoritative Undo's visible business postimage while retaining
    // the original operation history; no claim about SQL compensation is made.
    db.snapshot.data.opportunities = []; db.revision += 1
    const afterUndo = clone(db.snapshot)
    const replay = await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    expect(replay).toMatchObject({ receipt: first.receipt, result: { alreadyApplied: true, createdOpportunityIds: [] } })
    expect(db.snapshot).toEqual(afterUndo); expect(db.rows.get(value.commandId)).toEqual(row); expect(db.writes).toHaveLength(1)
  })

  it.each(['payload_hash', 'command_id', 'operation', 'resulting_revision'] as const)('does not trust a replay marker when ledger %s disagrees', async field => {
    const db = new LedgerHarness(), value = await command()
    await commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })
    db.ledgerTransform = rows => rows.map(row => ({ ...row, [field]: field === 'resulting_revision' ? 999 : 'different' }))
    await expect(commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })).rejects.toMatchObject({ code: 'DISCOVERY_RECEIPT_MISMATCH' })
    expect(db.writes).toHaveLength(1)
  })

  it('rejects a snapshot-only completion marker lacking the immutable ledger row', async () => {
    const db = new LedgerHarness(), value = await command()
    db.seedWinner(value); db.rows.clear()
    expect(discoveryCommandRun(db.snapshot, SOURCE, value.run.runId)).toBeDefined()
    await expect(commitVerifiedDiscoveryRun(db.source(), value, { discoveryAuthorization: AUTOMATION })).rejects.toMatchObject({ code: 'DISCOVERY_COMMIT_UNVERIFIED' })
    expect(db.attempts).toEqual([]); expect(db.writes).toEqual([])
  })
})
