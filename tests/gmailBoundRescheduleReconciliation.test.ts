import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gmailSemanticRecordFromMessage, gmailReconciliationStateForRecord, runGmailReconciliationForBinding } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { applyOpportunityMerge, readOpportunityMerge } from '../src/opportunityMerge.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import type { GmailAutomationBinding } from '../gateway/automationConnectionStore.js'

const source = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../gateway/driveWorkspaceSource.js', () => ({ createDriveWorkspaceSource: () => source }))
vi.mock('../gateway/transactionalWorkspaceSource.js', () => ({ createTransactionalWorkspaceSource: () => source }))
vi.mock('../gateway/tokenCrypto.js', () => ({ decryptSecret: async () => 'synthetic-refresh' }))
vi.mock('../gateway/googleOAuthTokens.js', () => ({ refreshGoogleAccessToken: async () => 'synthetic-access' }))
const now = new Date('2026-09-21T00:00:00Z')
const body = '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30'
const binding: GmailAutomationBinding = { userId: 'synthetic-user', googleSubject: 'synthetic-subject', refreshTokenCiphertext: 'synthetic-cipher',
  grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], gmailPendingMessageIds: [], gmailIntakeConsentVersion: 'uu06-v1' }
function mail(id: string, text = body, received = '2026-09-20T12:00:00Z') {
  return { id, threadId: 'synthetic-thread', internalDate: String(Date.parse(received)), payload: { mimeType: 'text/plain',
    headers: [{ name: 'Subject', value: '京东 AI产品经理 招聘进展' }], body: { data: Buffer.from(text).toString('base64url') } } }
}
let persisted: PJSDASSnapshot
let writes: number
function run(at = now, ids = ['move'], current = binding) {
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input))
    const payload = url.pathname.endsWith('/messages') ? { messages: ids.map(id => ({ id })) }
      : ids.some(id => url.pathname.endsWith(`/messages/${id}`)) ? mail(url.pathname.split('/').at(-1)!) : undefined
    if (!payload) throw new Error('Unexpected synthetic Gmail fetch')
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return runGmailReconciliationForBinding({ binding: current, tokenEncryptionKey: 'synthetic-key', googleClientId: 'synthetic-client',
    googleClientSecret: 'synthetic-value', forceStart: true, now: () => at, fetchImpl })
}
beforeEach(() => {
  writes = 0
  const base = createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理')], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] })
  const initial = gmailSemanticRecordFromMessage(mail('initial', '京东 AI产品经理 面试通知：2026年9月25日14:30', '2026-09-19T00:00:00Z'), base.data.opportunities, now)!
  persisted = applyGmailSemanticBatch(base, { records: [initial], runId: 'initial-run', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true }).snapshot
  source.read.mockImplementation(async () => ({ snapshot: structuredClone(persisted), context: { workspaceVersion: `synthetic-${writes}`, timezone: 'Asia/Shanghai' } }))
  source.write.mockImplementation(async input => { persisted = input.snapshot; writes += 1; return { snapshot: persisted, context: { workspaceVersion: `synthetic-${writes}` } } })
})
describe('bounded Gmail reschedule reconciliation proof through the actual worker', () => {
  it('records actionable target attribution and the fixed arrangement in the completion proof', async () => {
    const result = await run()
    expect(result.summary).toMatchObject({ scannedCount: 1, actionableCount: 1, unresolvedCount: 0, gmailOnlyCount: 0, pjsdasOnlyCount: 0, fixedOrHardWithin7DaysCount: 1 })
    expect(result.cycleComplete).toBe(true)
    expect(persisted.data.timeline.find(item => item.gmailReconciliation)?.gmailReconciliation).toMatchObject({ stateCounts: { ACTION_REQUIRED: 1, UNRESOLVED: 0 }, pjsdasOnlyCount: 0, fixedOrHardWithin7DaysCount: 1 })
    expect(writes).toBe(1)
    expect(JSON.stringify(persisted)).not.toContain(body)
  })
  it('returns the same summary after lost finalization without rebinding or writing the final snapshot', async () => {
    const first = await run(), after = structuredClone(persisted)
    const retry = await run()
    expect(retry.alreadyApplied).toBe(true)
    expect(retry.summary).toEqual(first.summary)
    expect(persisted).toEqual(after)
    expect(writes).toBe(1)
  })
  it('retains target attribution across a new reconciliation cycle', async () => {
    const first = await run()
    const retry = await run(new Date(now.getTime() + 60_000))
    expect(retry.summary).toEqual(first.summary)
    expect(persisted.data.scheduleNodes).toHaveLength(2)
    expect(persisted.data.processEvents).toHaveLength(1)
  })
  it('reconciles an already committed ordinary-parser fact without replaying its mutation', async () => {
    const original = gmailSemanticRecordFromMessage(mail('move'), persisted.data.opportunities, now)!
    persisted = applyGmailSemanticBatch(persisted, { records: [original], runId: 'ordinary-run', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true }).snapshot
    const nodes = structuredClone(persisted.data.scheduleNodes)
    const result = await run()
    expect(result.summary).toMatchObject({ actionableCount: 1, unresolvedCount: 0, pjsdasOnlyCount: 0 })
    expect(persisted.data.scheduleNodes).toEqual(nodes)
    expect(persisted.data.semanticReceipts?.filter(receipt => receipt.mutatedFactKeys?.some(key => key.startsWith('occurrence_rescheduled|')))).toHaveLength(1)
  })
  it('retains immutable source proof attribution after an actual audited opportunity merge', async () => {
    const first = await run()
    const originalReceipts = structuredClone(persisted.data.semanticReceipts)
    const job = persisted.data.opportunities[0]!
    job.detail = { discovery: { sourceUrl: 'https://careers.example/jobs/gmail-alias', sourceTitle: 'Synthetic posting', rationale: 'Synthetic evidence',
      discoveredAt: now.toISOString(), fitConfidence: 'high', opportunityValueConfidence: 'high' } }
    persisted.data.opportunities.push({ ...structuredClone(job), id: 'canonical-job' })
    const reviewed = await readOpportunityMerge(persisted, 'canonical-job', 'jd')
    persisted = (await applyOpportunityMerge(persisted, { canonicalOpportunityId: 'canonical-job', duplicateOpportunityId: 'jd',
      expectedFingerprint: reviewed.fingerprint, dependencies: reviewed.dependencies, reason: 'Exact synthetic posting identity',
      evidenceRefs: ['https://careers.example/jobs/gmail-alias'] }, 'synthetic-gmail-proof-merge', now)).snapshot
    const afterMerge = structuredClone(persisted.data.scheduleNodes)
    const next = await run(new Date(now.getTime() + 60_000))
    expect(next.summary).toEqual(first.summary)
    expect(persisted.data.scheduleNodes).toEqual(afterMerge)
    expect(persisted.data.semanticReceipts).toEqual(originalReceipts)
    const withoutAlias = structuredClone(persisted); withoutAlias.data.opportunityAliases = []
    const reread = gmailSemanticRecordFromMessage(mail('move'), withoutAlias.data.opportunities, now)!
    expect(gmailReconciliationStateForRecord(reread, withoutAlias)).toBe('UNRESOLVED')
  })
  it('retains prefix attribution when a saved continuation is lost', async () => {
    const first = await run(now, ['move', 'later-unrelated'])
    expect(first.cycleComplete).toBe(false)
    expect(first.continuation?.aggregate.gmailOpportunityIds).toEqual(['jd'])
    const retry = await run(now, ['move', 'later-unrelated'])
    expect(retry.continuation).toEqual(first.continuation)
    expect(retry.summary).toEqual(first.summary)
    expect(writes).toBe(1)
  })
})
