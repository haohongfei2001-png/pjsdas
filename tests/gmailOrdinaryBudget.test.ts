import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runControlledGmailExecutions } from '../gateway/gmailControlledExecution.js'
import { fetchGmailAutomationBatch } from '../gateway/gmailAutomation.js'
import { createSnapshot } from '../src/snapshot.js'
const state = vi.hoisted(() => ({ sourceOptions: undefined as any, snapshot: undefined as any, writtenIds: [] as string[], readDelayMs: 0 }))
vi.mock('../gateway/transactionalWorkspaceSource.js', () => ({ createTransactionalWorkspaceSource: (options: any) => {
  state.sourceOptions = options
  return {
    read: async () => { await delay(state.readDelayMs); return { snapshot: structuredClone(state.snapshot), context: { workspaceVersion: 'txn:1', timezone: 'UTC' } } },
    write: async (input: any) => {
      await options.fetchImpl('https://synthetic.invalid/commit', { method: 'POST', body: '{}' })
      state.snapshot = input.snapshot
      state.writtenIds.push(...input.command.payload.recordIds)
      return { snapshot: state.snapshot, context: { workspaceVersion: 'txn:2', timezone: 'UTC' } }
    },
  }
} }))
vi.mock('../gateway/tokenCrypto.js', () => ({ decryptSecret: async () => 'synthetic-refresh' }))
vi.mock('../gateway/googleOAuthTokens.js', () => ({ refreshGoogleAccessToken: async () => 'synthetic-access' }))
const ids = Array.from({ length: 20 }, (_, i) => `synthetic-${i}`)
const row = { user_id: 'synthetic-user', google_subject: 'synthetic-subject', refresh_token_ciphertext: 'synthetic-cipher',
  granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'], gmail_history_id: 'old-history', gmail_intake_consent_version: 'uu06-v1', gmail_pending_message_ids: [] }
function delay(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Synthetic budget abort')) }, { once: true })
  })
}
function harness(messageMs: number, binding: Record<string, unknown> = row, at = '2026-10-25T00:00:00Z') {
  const fetched: string[] = [], finishes: any[] = [], commits: number[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), rpc = url.pathname.split('/').at(-1)
    if (rpc === 'pjsdas_claim_gmail_automation_bindings_v5') return Response.json([binding])
    if (rpc === 'pjsdas_begin_gmail_execution') return Response.json(binding)
    if (rpc === 'pjsdas_assert_gmail_execution') return Response.json(true)
    if (rpc === 'pjsdas_finish_gmail_execution') { finishes.push(JSON.parse(String(init?.body))); return Response.json(true) }
    if (rpc === 'profile') return Response.json({ historyId: 'new-history' })
    if (rpc === 'history') return Response.json({ history: [{ messagesAdded: ids.map(id => ({ message: { id } })) }], historyId: 'new-history' })
    if (url.pathname.includes('/messages/')) {
      await delay(messageMs, init?.signal); fetched.push(rpc!)
      return Response.json({ id: rpc, threadId: rpc, internalDate: '1792886400000', payload: { mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: '普通消息' }], body: { data: Buffer.from('普通消息，无招聘事实。').toString('base64url') } } })
    }
    if (rpc === 'commit') { commits.push(performance.now()); await delay(80, init?.signal); return Response.json({}) }
    throw new Error('Unexpected synthetic endpoint')
  }
  const run = () => runControlledGmailExecutions({ supabaseUrl: 'https://synthetic.invalid', supabasePublishableKey: 'synthetic',
    tokenEncryptionKey: 'synthetic', googleClientId: 'synthetic', googleClientSecret: 'synthetic', fetchImpl,
    executionBudgetMs: 200, now: () => new Date(at) }, 'synthetic-worker')
  return { fetched, finishes, commits, run }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional')
  state.snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
  state.writtenIds = []; state.readDelayMs = 0
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
describe('ordinary Gmail work budget before snapshot commit', () => {
  it('does not write an empty snapshot when the first fetch slice cannot fit', async () => {
    state.readDelayMs = 130
    const h = harness(0), pending = h.run(); await vi.runAllTimersAsync()
    await expect(pending).resolves.toMatchObject({ failedUsers: 1, results: [{ code: 'BUDGET_EXHAUSTED' }] })
    expect(h.fetched).toEqual([]); expect(h.commits).toEqual([])
    expect(h.finishes[0].state_patch).toEqual({})
    state.readDelayMs = 0
    const next = harness(0), retry = next.run(); await vi.runAllTimersAsync()
    await expect(retry).resolves.toMatchObject({ successfulUsers: 1 })
    expect(next.fetched).toEqual(ids); expect(state.writtenIds).toEqual(ids)
  })

  it('reproduces fetch work starving commit, while failed work does not advance cursor', async () => {
    const h = harness(100), pending = h.run(); await vi.runAllTimersAsync(); const result = await pending
    expect(h.fetched).toEqual(ids.slice(0, 5))
    expect(h.commits).toEqual([100]) // A single slow batch still cannot extend the safety cap.
    expect(result).toMatchObject({ failedUsers: 1, results: [{ status: 'error', code: 'BUDGET_EXHAUSTED' }] })
    expect(state.writtenIds).toEqual([])
    expect(h.finishes).toHaveLength(1); expect(h.finishes[0].state_patch).toEqual({})
    const retry = harness(0), second = retry.run(); await vi.runAllTimersAsync(); await expect(second).resolves.toMatchObject({ successfulUsers: 1 })
    expect(retry.fetched).toEqual(ids); expect(state.writtenIds).toEqual(ids)
    expect(retry.finishes[0].state_patch).toMatchObject({ historyId: 'new-history', continuation: null })
  })
  it('required behavior: yields before exhausting the snapshot commit window and retains unprocessed message IDs', async () => {
    const h = harness(30), pending = h.run(); await vi.runAllTimersAsync(); const result = await pending
    expect(result.successfulUsers).toBe(1)
    expect(h.finishes[0].state_patch.historyId).toBeUndefined()
    expect(h.finishes[0].state_patch.continuation.pendingMessageIds.length).toBeGreaterThan(0)
    const continuation = h.finishes[0].state_patch.continuation
    expect(new Set([...state.writtenIds, ...continuation.pendingMessageIds])).toEqual(new Set(ids))
    expect(state.writtenIds.length).toBeGreaterThan(0)
    expect(h.fetched.length).toBeLessThan(20)
    const next = harness(0, { ...row, gmail_sync_mode: continuation.mode,
      gmail_pending_history_id: continuation.pendingHistoryId,
      gmail_pending_message_ids: continuation.pendingMessageIds,
      gmail_page_token: continuation.pageToken }, '2026-10-25T00:01:00Z')
    const resumed = next.run(); await vi.runAllTimersAsync(); await expect(resumed).resolves.toMatchObject({ successfulUsers: 1 })
    expect(next.fetched).toEqual(continuation.pendingMessageIds)
    expect(state.writtenIds).toEqual(ids)
    expect(next.finishes[0].state_patch).toMatchObject({ historyId: 'new-history', continuation: null })
  })
})

describe('ordinary budget continuation boundaries', () => {
  it.each([0, 5])('keeps page/cursor and every deferred ID when yielding after %i messages', async completed => {
    const all = Array.from({ length: 25 }, (_, i) => `bounded-${i}`)
    const fetched: string[] = [], parsed: string[] = []
    const fetchImpl: typeof fetch = async input => {
      const u = new URL(String(input)), id = u.pathname.split('/').at(-1)!
      if (id === 'profile') return Response.json({ historyId: 'current' })
      if (id === 'history') return Response.json({ history: [{ messagesAdded: all.map(id => ({ message: { id } })) }], nextPageToken: 'next-page' })
      fetched.push(id)
      return id === 'bounded-0' ? new Response('', { status: 404 }) : Response.json({ id })
    }
    const result = await fetchGmailAutomationBatch({ accessToken: 'synthetic', startHistoryId: 'old', coverage: 'uu06', fetchImpl,
      slice: { canFetchNextBatch: () => fetched.length < completed, onMessage: message => { parsed.push(message.id!) } } })
    expect(fetched).toEqual(all.slice(0, completed))
    expect(parsed).toEqual(all.slice(1, completed))
    expect(result.unavailableMessageIds).toEqual(completed ? ['bounded-0'] : [])
    expect(result.coverageComplete).toBe(false)
    expect(result.nextHistoryId).toBeUndefined()
    expect(result.continuation).toEqual({ mode: 'history', pageToken: 'next-page', pendingHistoryId: 'current', pendingMessageIds: all.slice(completed) })
  })
})
