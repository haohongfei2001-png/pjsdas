import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconciliationRecordVersion, gmailSemanticRecordFromMessage, runGmailReconciliationForBinding } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import type { GmailAutomationBinding } from '../gateway/automationConnectionStore.js'
const source = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../gateway/driveWorkspaceSource.js', () => ({ createDriveWorkspaceSource: () => source }))
vi.mock('../gateway/transactionalWorkspaceSource.js', () => ({ createTransactionalWorkspaceSource: () => source }))
vi.mock('../gateway/tokenCrypto.js', () => ({ decryptSecret: async () => 'synthetic-refresh' }))
vi.mock('../gateway/googleOAuthTokens.js', () => ({ refreshGoogleAccessToken: async () => 'synthetic-access' }))
const now = new Date('2026-10-12T04:00:00Z')
const job = opportunity('synthetic-product', '甲星公司', '产品经理')
function message(id: string) {
  return { id, threadId: 'synthetic-shared-thread', internalDate: String(now.getTime()), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '甲星公司 产品经理 面试邀请' }],
    body: { data: Buffer.from('甲星公司 产品经理 面试时间2026年10月15日18:50').toString('base64url') } } }
}
const binding: GmailAutomationBinding = { userId: 'synthetic-user', googleSubject: 'synthetic-subject', refreshTokenCiphertext: 'synthetic-cipher',
  grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], gmailPendingMessageIds: [], gmailIntakeConsentVersion: 'uu06-v1' }
let persisted: PJSDASSnapshot
let writes = 0
const ids = Array.from({ length: 20 }, (_, index) => `synthetic-message-${index}`)
const fetchImpl: typeof fetch = async input => {
  const url = new URL(String(input))
  const payload = url.pathname.endsWith('/messages') ? { messages: ids.map(id => ({ id })) }
    : ids.some(id => url.pathname.endsWith(`/messages/${id}`)) ? message(url.pathname.split('/').at(-1)!) : undefined
  if (!payload) throw new Error(`Unexpected synthetic fetch: ${url.pathname}`)
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}
async function run(current = binding, canProcessNextMessage?: () => boolean, observedAt = now) {
  return runGmailReconciliationForBinding({ binding: current, tokenEncryptionKey: 'synthetic-key', googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-value',
    forceStart: true, now: () => observedAt, fetchImpl, execution: { beforeWorkspaceWrite: async () => {}, canProcessNextMessage } })
}
beforeEach(() => {
  writes = 0
  persisted = createSnapshot({ opportunities: [job], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] })
  source.read.mockImplementation(async () => ({ snapshot: structuredClone(persisted), context: { workspaceVersion: `synthetic-${writes}`, timezone: 'Asia/Shanghai' } }))
  source.write.mockImplementation(async input => { persisted = input.snapshot; writes += 1; return { snapshot: persisted, context: { workspaceVersion: `synthetic-${writes}` } } })
})
describe('bounded Gmail reconciliation whole-message prefixes', () => {
  it('observes phases without changing the five-message commit or continuation', async () => {
    const phases: string[] = []
    let processed = 0
    const observed = await runGmailReconciliationForBinding({ binding, tokenEncryptionKey: 'synthetic-key', googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-value',
      forceStart: true, now: () => now, fetchImpl, execution: {
        observer: { phase: value => phases.push(value), processed: () => { processed += 1 } },
        beforeWorkspaceWrite: async () => { phases.push('lease_assert') },
      } })
    expect(phases).toEqual(['token_refresh', 'workspace_read', 'gmail_list', 'message_parse', 'semantic_apply', 'lease_assert', 'workspace_commit', 'checkpoint'])
    expect(processed).toBe(5)
    expect(observed.summary.scannedCount).toBe(5)
    expect(observed.continuation?.pendingMessageIds).toEqual(ids.slice(5))
    expect(writes).toBe(1)
  })

  it('commits a budget-bounded prefix, retains fetched remainder and eventually covers all records once', async () => {
    let allowed = 2
    let result = await run(binding, () => allowed-- > 0)
    expect(result.cycleComplete).toBe(false)
    expect(result.summary.scannedCount).toBe(2)
    expect(result.metrics).toMatchObject({ receivedCount: 5, accountedCount: 2 })
    expect(result.continuation?.pendingMessageIds).toEqual(ids.slice(2))
    expect(persisted.data.timeline?.some(item => item.gmailReconciliation)).toBe(false)
    while (!result.cycleComplete) {
      const before = result.summary.scannedCount
      result = await run({ ...binding, gmailReconciliationState: result.continuation })
      expect(result.summary.scannedCount - before).toBeLessThanOrEqual(5)
    }
    expect(result.summary.scannedCount).toBe(20)
    expect(persisted.data.processEvents).toHaveLength(1)
    expect(persisted.data.scheduleNodes).toHaveLength(1)
    expect(new Set(persisted.data.timeline?.flatMap(item => item.ingestion ? [item.ingestion.sourceRecordId] : [])).size).toBe(20)
    expect(persisted.data.timeline?.filter(item => item.gmailReconciliation)).toHaveLength(1)
  })
  it('does not duplicate facts or accounting when a successful write loses its continuation finalization', async () => {
    const first = await run()
    const afterWrite = JSON.stringify(persisted)
    const retry = await run() // old binding: simulate lost finish/checkpoint
    expect(retry.continuation).toEqual(first.continuation)
    expect(retry.summary.scannedCount).toBe(5)
    expect(retry.alreadyApplied).toBe(true)
    expect(writes).toBe(1)
    expect(JSON.stringify(persisted)).toBe(afterWrite)
    const next = await run({ ...binding, gmailReconciliationState: retry.continuation })
    expect(next.summary.scannedCount).toBe(10)
    expect(persisted.data.processEvents).toHaveLength(1)
  })
  it('keeps facts idempotent when a first-batch retry advances time and grows its prefix', async () => {
    let allowed = 2
    const first = await run(binding, () => allowed-- > 0)
    expect(first.summary.scannedCount).toBe(2)
    // No saved continuation: the first prefix committed, but finalization was
    // lost. A later retry may have a larger budget and a new cycle timestamp.
    const retry = await run(binding, undefined, new Date(now.getTime() + 60_000))
    expect(retry.summary.scannedCount).toBe(5)
    expect(retry.continuation?.pendingMessageIds).toEqual(ids.slice(5))
    expect(persisted.data.processEvents).toHaveLength(1)
    expect(persisted.data.scheduleNodes).toHaveLength(1)
    expect(new Set(persisted.data.timeline?.flatMap(item => item.ingestion ? [item.ingestion.sourceRecordId] : [])).size).toBe(5)
    const next = await run({ ...binding, gmailReconciliationState: retry.continuation }, undefined, new Date(now.getTime() + 120_000))
    expect(next.summary.scannedCount).toBe(10)
    expect(persisted.data.processEvents).toHaveLength(1)
  })
  it('preserves the prior checkpoint and writes nothing when no whole message can start', async () => {
    await expect(run(binding, () => false)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
    expect(writes).toBe(0)
    expect(persisted.data.timeline ?? []).toHaveLength(0)
  })
  it('bounds a 445-opportunity, twenty-mail procedural workload to whole five-message slices', async () => {
    persisted.data.opportunities = Array.from({ length: 445 }, (_, index) => opportunity(`synthetic-stress-${index}`, `合成企业${index}`, `合成岗位${index}`))
    const body = Array.from({ length: 60 }, () => '面试前请检查摄像头和麦克风').join('；')
    const pressureFetch: typeof fetch = async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/messages')) return new Response(JSON.stringify({ messages: ids.map(id => ({ id })) }))
      const id = url.pathname.split('/').at(-1)!
      return new Response(JSON.stringify({ ...message(id), payload: { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } } }))
    }
    let current = binding
    for (let slice = 0; slice < 4; slice += 1) {
      const started = performance.now()
      const result = await runGmailReconciliationForBinding({ binding: current, tokenEncryptionKey: 'synthetic-key', googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-value', forceStart: true, now: () => now, fetchImpl: pressureFetch })
      expect(performance.now() - started).toBeLessThan(20_000)
      expect(result.summary.scannedCount).toBe((slice + 1) * 5)
      expect(result.cycleComplete).toBe(slice === 3)
      current = { ...binding, gmailReconciliationState: result.continuation }
    }
    expect(persisted.data.processEvents).toHaveLength(0)
    expect(persisted.data.decisionRequests ?? []).toHaveLength(0)
  }, 60_000)
  it('does not replay a committed v1 fact when the source parser changes to v2', () => {
    const record = gmailSemanticRecordFromMessage(message('synthetic-versioned'), [job], now)!
    record.observation.inputId = 'gmail:synthetic-versioned:reconciliation-v1'
    record.observation.source.sourceVersion = 'reconciliation-v1'
    const first = applyGmailSemanticBatch(persisted, { runId: 'synthetic-v1', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record], reconcileExisting: true })
    const next = applyGmailSemanticBatch(first.snapshot, { runId: 'synthetic-v2', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true,
      records: [reconciliationRecordVersion(record)], reconcileExisting: true })
    expect(next.snapshot.data.processEvents).toHaveLength(1)
    expect(next.snapshot.data.scheduleNodes).toHaveLength(1)
    expect(next.snapshot.data.actions).toHaveLength(first.snapshot.data.actions.length)
  })
})
