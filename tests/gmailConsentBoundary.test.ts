import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import { GMAIL_READONLY_SCOPE, createAutomationConnectionStore } from '../gateway/automationConnectionStore.js'
import { runGmailAutomationForBinding } from '../gateway/gmailAutomation.js'
const state = vi.hoisted(() => ({ snapshot: undefined as unknown, write: vi.fn() }))
vi.mock('../gateway/tokenCrypto.js', () => ({ decryptSecret: async () => 'test-refresh' }))
vi.mock('../gateway/googleOAuthTokens.js', () => ({ refreshGoogleAccessToken: async () => 'test-access' }))
vi.mock('../gateway/driveWorkspaceSource.js', () => ({ createDriveWorkspaceSource: () => ({
  read: async () => ({ snapshot: state.snapshot, context: { workspaceVersion: 'test-v1', timezone: 'Asia/Shanghai' } }),
  write: state.write,
}) }))
const now = new Date('2026-09-21T00:00:00Z')
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }
beforeEach(() => {
  vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'drive')
  const snapshot: PJSDASSnapshot = { schema: 'pjsdas-local-snapshot', version: 1, exportedAt: now.toISOString(), data: {
    opportunities: [{ id: 'jd', company: '京东', role: 'AI产品经理', currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, fitScore: 80, opportunityValue: 80, locallyManaged: true, importedAt: '2026-09-01T00:00:00Z' }],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
  } }
  state.snapshot = snapshot
  state.write.mockReset().mockResolvedValue({ context: { workspaceVersion: 'test-v2' } })
})
async function worker(consent?: 'uu06-v1', extra: Record<string, unknown> = {}, observe = false, validHistory = false) {
  const calls: URL[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); calls.push(url)
    if (url.pathname.endsWith('/profile')) return json({ historyId: '900' })
    if (url.pathname.endsWith('/history')) return validHistory ? json({ history: [{ messagesAdded: [{ message: { id: 'mail', labelIds: ['INBOX'] } }] }], historyId: '900' }) : json({ code: 'expired' }, 404)
    if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'mail' }] })
    return json({ id: 'mail', threadId: 'thread', internalDate: String(now.getTime()), payload: { mimeType: 'text/plain',
      body: { data: Buffer.from('京东 AI产品经理 面试通知2026年9月25日 14:30；地点：会议室A；会议链接：https://meet.example.com/room').toString('base64url') } } })
  }) as unknown as typeof fetch
  const run = await runGmailAutomationForBinding({ binding: { userId: 'synthetic', googleSubject: 'synthetic-subject', refreshTokenCiphertext: 'fixture', grantedScopes: [GMAIL_READONLY_SCOPE], gmailPendingMessageIds: [], gmailIntakeConsentVersion: consent, ...extra },
    tokenEncryptionKey: 'fixture', googleClientId: 'fixture', googleClientSecret: 'fixture', fetchImpl, now: () => now, ...(observe ? { execution: { beforeWorkspaceWrite: async () => {} } } : {}) })
  return { calls, run, snapshot: state.write.mock.calls[0]![0].snapshot as PJSDASSnapshot }
}
describe('UU06 explicit source consent boundary', () => {
  it('collects history latency only for newly consumed source messages and separates backfill', async () => {
    const first = await worker('uu06-v1', { gmailHistoryId: 'old' }, true, true)
    expect(first.run.metrics).toMatchObject({ mode: 'history', historyLag: { count: 1, maxMs: 0 } })
    state.snapshot = first.snapshot
    const replay = await worker('uu06-v1', { gmailHistoryId: 'old' }, true, true)
    expect(replay.run.metrics?.historyLag?.count).toBe(0)
    const backfill = await worker('uu06-v1', {}, true)
    expect(backfill.run.metrics?.mode).toBe('initial_backfill')
    expect(backfill.run.metrics).not.toHaveProperty('historyLag')
    const recovery = await worker('uu06-v1', { gmailHistoryId: 'expired' }, true)
    expect(recovery.run.metrics?.mode).toBe('history_recovery')
    expect(recovery.run.metrics).not.toHaveProperty('historyLag')
    const dormant = await worker('uu06-v1')
    expect(dormant.run.metrics).toBeUndefined()
  })
  it('old enabled binding with no history remains 7-day INBOX and legacy extraction', async () => {
    const result = await worker()
    const query = result.calls.find((url) => url.pathname.endsWith('/messages'))!
    expect(query.searchParams.get('q')).toBe('newer_than:7d -in:spam -in:trash')
    expect(query.searchParams.get('labelIds')).toBe('INBOX')
    expect(result.snapshot.data.processEvents.every((event) => !event.location && !event.joinUrl)).toBe(true)
    expect(result.snapshot.data.semanticReceipts ?? []).toHaveLength(0)
  })
  it('expanded metadata and archive backfill require explicit versioned consent', async () => {
    const result = await worker('uu06-v1')
    const query = result.calls.find((url) => url.pathname.endsWith('/messages'))!
    expect(query.searchParams.has('labelIds')).toBe(false)
    expect(query.searchParams.get('q')).toContain('after:')
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ location: '会议室A', joinUrl: 'https://meet.example.com/room' })
    expect(result.snapshot.data.semanticReceipts?.[0]?.commandId).toBe(`gmail:auto:${now.toISOString()}`)
  })
  it('legacy expired history retains INBOX filtering and seven-day fallback', async () => {
    const result = await worker(undefined, { gmailHistoryId: 'old' })
    expect(result.calls.find((url) => url.pathname.endsWith('/history'))?.searchParams.get('labelId')).toBe('INBOX')
    expect(result.calls.find((url) => url.pathname.endsWith('/messages'))?.searchParams.get('q')).toBe('newer_than:7d -in:spam -in:trash')
  })
  it('a revoked expanded continuation resumes from committed history with legacy limits', async () => {
    // Exact binding state emitted by the SQL trigger on uu06-v1 -> NULL.
    const result = await worker(undefined, { gmailHistoryId: 'committed', gmailSyncMode: null,
      gmailPageToken: null, gmailPendingHistoryId: null, gmailPendingMessageIds: [] })
    expect(result.calls.find((url) => url.pathname.endsWith('/history'))?.searchParams.get('startHistoryId')).toBe('committed')
    expect(result.calls.find((url) => url.pathname.endsWith('/history'))?.searchParams.get('labelId')).toBe('INBOX')
    expect(result.calls.some((url) => url.pathname.includes('archive-pending'))).toBe(false)
    expect(result.calls.find((url) => url.pathname.endsWith('/messages'))?.searchParams.get('q')).toContain('newer_than:7d')
  })
  it('legacy continuation retains its provider token and history watermark', async () => {
    const result = await worker(undefined, { gmailSyncMode: 'fallback', gmailPageToken: 'legacy-page-2', gmailPendingHistoryId: '800' })
    expect(result.calls.find((url) => url.pathname.endsWith('/messages'))?.searchParams.get('pageToken')).toBe('legacy-page-2')
  })
  it('falls back through v3 to v2 only on missing functions and forces expanded consent absent', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url)
      if (url.endsWith('bindings_v5') || url.endsWith('bindings_v4') || url.endsWith('bindings_v3')) return json({ code: 'PGRST202' }, 404)
      return json([{ user_id: 'u', google_subject: 'g', refresh_token_ciphertext: 'c', gmail_intake_consent_version: 'uu06-v1' }])
    }) as unknown as typeof fetch
    const store = createAutomationConnectionStore({ supabaseUrl: 'https://example.invalid', supabasePublishableKey: 'test', workerToken: 'test', fetchImpl })
    const bindings = await store.listEnabledGmailBindings()
    expect(calls).toHaveLength(4)
    expect(bindings[0]?.gmailIntakeConsentVersion).toBeUndefined()
  })
  it('never falls back around an authorization denial', async () => {
    const fetchImpl = vi.fn(async () => json({ code: '42501' }, 403)) as unknown as typeof fetch
    const store = createAutomationConnectionStore({ supabaseUrl: 'https://example.invalid', supabasePublishableKey: 'test', workerToken: 'test', fetchImpl })
    await expect(store.listEnabledGmailBindings()).rejects.toThrow('authorization is invalid')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
