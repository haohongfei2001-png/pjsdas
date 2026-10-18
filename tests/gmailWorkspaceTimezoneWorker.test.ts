import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gmailWorkspaceTimezone, runGmailAutomationForBinding, runGmailReconciliationForBinding } from '../gateway/gmailAutomation.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import type { GmailAutomationBinding } from '../gateway/automationConnectionStore.js'

const source = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../gateway/driveWorkspaceSource.js', () => ({ createDriveWorkspaceSource: () => source }))
vi.mock('../gateway/transactionalWorkspaceSource.js', () => ({ createTransactionalWorkspaceSource: () => source }))
vi.mock('../gateway/tokenCrypto.js', () => ({ decryptSecret: async () => 'synthetic-refresh' }))
vi.mock('../gateway/googleOAuthTokens.js', () => ({ refreshGoogleAccessToken: async () => 'synthetic-access' }))
const now = new Date('2026-09-21T00:00:00Z')
const binding: GmailAutomationBinding = { userId: 'synthetic-user', googleSubject: 'synthetic-subject', refreshTokenCiphertext: 'synthetic-cipher',
  grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], gmailPendingMessageIds: [], gmailIntakeConsentVersion: 'uu06-v1' }
const mail = { id: 'synthetic-zone', threadId: 'synthetic-thread', internalDate: String(now.getTime()), payload: { mimeType: 'text/plain',
  headers: [{ name: 'Subject', value: '京东 AI产品经理 招聘进展' }],
  body: { data: Buffer.from('京东 AI产品经理 面试通知：2026年9月25日14:30').toString('base64url') } } }
let persisted: PJSDASSnapshot
let contextZone: string | undefined
let writes: number
const fetchImpl: typeof fetch = async input => {
  const url = new URL(String(input))
  const payload = url.pathname.endsWith('/profile') ? { historyId: 'synthetic-history' }
    : url.pathname.endsWith('/messages') ? { messages: [{ id: mail.id }] }
    : url.pathname.endsWith(`/messages/${mail.id}`) ? mail : undefined
  if (!payload) throw new Error('Unexpected synthetic Gmail request')
  return new Response(JSON.stringify(payload), { status: 200 })
}
function run(kind: string) {
  const options = { binding, tokenEncryptionKey: 'synthetic-key', googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-value', now: () => now, fetchImpl }
  return kind === 'normal' ? runGmailAutomationForBinding(options) : runGmailReconciliationForBinding({ ...options, forceStart: true })
}
beforeEach(() => {
  writes = 0; contextZone = 'Asia/Shanghai'
  persisted = createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理')], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
  source.read.mockImplementation(async () => ({ snapshot: structuredClone(persisted), context: { workspaceVersion: `synthetic-${writes}`, timezone: contextZone } }))
  source.write.mockImplementation(async input => { persisted = input.snapshot; writes += 1; return { snapshot: persisted, context: { workspaceVersion: `synthetic-${writes}`, timezone: contextZone } } })
})

describe('Gmail normal and reconciliation callers retain the same trusted timezone contract', () => {
  it.each(['normal', 'reconciliation'])('%s honors saved UTC ahead of legacy Drive context Shanghai', async kind => {
    persisted.data.timePlanning = { version: 1, timezone: 'UTC', updatedAt: now.toISOString() }
    await run(kind)
    expect(persisted.data.processEvents[0]).toMatchObject({ dueAt: '2026-09-25T14:30:00+00:00' })
    expect(persisted.data.scheduleNodes![0]).toMatchObject({ temporal: { startAt: '2026-09-25T14:30:00+00:00', timezone: 'UTC' } })
    expect(writes).toBe(1)
  })
  it.each(['normal', 'reconciliation'])('%s preserves the established service default without saved preference', async kind => {
    await run(kind)
    expect(persisted.data.processEvents[0]).toMatchObject({ dueAt: '2026-09-25T14:30:00+08:00' })
    expect(writes).toBe(1)
  })
  it.each(['normal', 'reconciliation'])('%s records unresolved coverage when both account preference and source context are absent', async kind => {
    contextZone = undefined
    await run(kind)
    expect(persisted.data.processEvents).toEqual([])
    expect(persisted.data.scheduleNodes).toEqual([])
    expect(persisted.data.timeline.some(item => item.ingestion?.sourceRecordId === mail.id && item.ingestion.outcome === 'unresolved')).toBe(true)
  })
  it.each(['normal', 'reconciliation'])('%s does not reinterpret a consumed notice when the owner later changes timezone', async kind => {
    await run(kind)
    const events = structuredClone(persisted.data.processEvents), nodes = structuredClone(persisted.data.scheduleNodes)
    persisted.data.timePlanning = { version: 1, timezone: 'UTC', updatedAt: now.toISOString() }
    await run(kind)
    expect(persisted.data.processEvents).toEqual(events)
    expect(persisted.data.scheduleNodes).toEqual(nodes)
  })
  it('does not duplicate an ordinary consumed notice on its first reconciliation after timezone changes', async () => {
    await run('normal')
    const events = structuredClone(persisted.data.processEvents), nodes = structuredClone(persisted.data.scheduleNodes)
    persisted.data.timePlanning = { version: 1, timezone: 'UTC', updatedAt: now.toISOString() }
    await run('reconciliation')
    expect(persisted.data.processEvents).toEqual(events)
    expect(persisted.data.scheduleNodes).toEqual(nodes)
    expect(persisted.data.timeline.some(item => item.ingestion?.sourceRecordId === mail.id && item.ingestion.outcome === 'unresolved')).toBe(true)
  })
  it('does not replace an explicitly invalid saved preference with valid context', () => {
    persisted.data.timePlanning = { version: 1, timezone: 'Unknown/Place', updatedAt: now.toISOString() }
    expect(gmailWorkspaceTimezone({ snapshot: persisted, context: { now, timezone: 'UTC' } })).toBe('Unknown/Place')
  })
})
