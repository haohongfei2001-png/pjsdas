import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGmailAutomationHandler } from '../gateway/gmailAutomationHandler.js'
import { aggregateHistoryLag } from '../gateway/gmailExecutionMetrics.js'
const state = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../gateway/gmailAutomation.js', () => ({ runGmailAutomationForBinding: state.run }))
const row = { user_id: 'user', google_subject: 'subject', refresh_token_ciphertext: 'cipher', granted_scopes: [], gmail_history_id: 'list-old' }
const result = { coverageComplete: true, checkedAt: '2026-09-21T00:00:00Z', nextHistoryId: 'committed',
  metrics: { status: 'completed', mode: 'history', receivedCount: 1, accountedCount: 1, historyLag: { count: 1, sumMs: 1000, maxMs: 1000, under2m: 1, under15m: 0, over15m: 0 } } }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }
function harness(options: { coalesce?: boolean; assertValid?: boolean; budgetMs?: number; finishLost?: boolean; missingClaim?: boolean } = {}) {
  const writes: { rpc: string; data: Record<string, unknown> }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const rpc = String(input).split('/').at(-1)!; const data = JSON.parse(String(init?.body ?? '{}'))
    writes.push({ rpc, data })
    if (rpc === 'pjsdas_claim_gmail_automation_bindings_v3') return json([row, { ...row, user_id: 'later' }])
    if (rpc === 'pjsdas_begin_gmail_execution') return options.missingClaim ? json({ code: 'PGRST202' },404) : json(options.coalesce ? null : { ...row, gmail_history_id: 'fresh', user_id: data.target_user_id })
    if (rpc === 'pjsdas_assert_gmail_execution') return json(options.assertValid ?? true)
    if (rpc === 'pjsdas_finish_gmail_execution') {
      if (options.finishLost && data.state_patch && Object.keys(data.state_patch as object).length) throw new Error('Synthetic lost response after commit')
      return json(!options.finishLost)
    }
    if (rpc === 'slow') return new Promise((_resolve,reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    throw new Error('Unexpected RPC: '+rpc)
  }
  const handler = createGmailAutomationHandler({ supabaseUrl: 'https://example.invalid', supabasePublishableKey: 'test', tokenEncryptionKey: 'test', googleClientId: 'test', googleClientSecret: 'test', fetchImpl,
    executionControlsEnabled: true, executionBudgetMs: options.budgetMs })
  const invoke = (all = false) => handler(new Request(`https://example.invalid/worker${all ? '' : '?userId=user'}`, { headers: { authorization: 'Bearer synthetic-worker' } }))
  return { writes, invoke }
}
beforeEach(() => { state.run.mockReset().mockImplementation(async (options) => { await options.execution.beforeWorkspaceWrite(); return result }) })
describe('opt-in controlled Gmail worker', () => {
  it('uses a fresh claimed binding and finishes state under the same lease after a guarded write', async () => {
    const h = harness(); const response = await h.invoke()
    expect(response.status).toBe(200)
    expect(state.run.mock.calls[0]?.[0].binding.gmailHistoryId).toBe('fresh')
    const begin = h.writes.find((item) => item.rpc === 'pjsdas_begin_gmail_execution')!
    const finish = h.writes.find((item) => item.rpc === 'pjsdas_finish_gmail_execution')!
    expect(finish.data.execution_token).toBe(begin.data.execution_token)
    expect(finish.data.state_patch).toMatchObject({ historyId: 'committed', continuation: null })
    expect(h.writes.some((item) => item.rpc.endsWith('state_v2'))).toBe(false)
    expect(await response.text()).not.toContain('user')
  })
  it('coalesces a busy binding without source access or cursor writes', async () => {
    const h = harness({ coalesce: true }); const response = await h.invoke()
    expect(state.run).not.toHaveBeenCalled()
    expect(h.writes).toHaveLength(2)
    await expect(response.json()).resolves.toMatchObject({ coalescedUsers: 1, processedUsers: 0 })
  })
  it('does not fall back to an unfenced legacy path if opt-in RPC is absent', async () => {
    const h = harness({ missingClaim: true }); const response = await h.invoke()
    expect(response.status).toBe(207)
    expect(state.run).not.toHaveBeenCalled()
    expect(h.writes.some((item) => item.rpc.endsWith('state_v2'))).toBe(false)
  })
  it('lost lease stops before the workspace write and sends no cursor patch', async () => {
    const h = harness({ assertValid: false }); const response = await h.invoke()
    expect(response.status).toBe(207)
    const finish = h.writes.find((item) => item.rpc === 'pjsdas_finish_gmail_execution')!
    expect(finish.data.state_patch).toEqual({})
    expect(finish.data.metrics).toMatchObject({ status: 'error', errorCode: 'LEASE_LOST' })
  })
  it('budget aborts pending I/O, preserves cursor, and defers remaining bindings', async () => {
    state.run.mockImplementation(async (options) => { await options.fetchImpl('https://example.invalid/slow'); return result })
    const h = harness({ budgetMs: 100 }); const started = Date.now(); const response = await h.invoke(true)
    expect(Date.now()-started).toBeLessThan(1000)
    await expect(response.json()).resolves.toMatchObject({ failedUsers: 1, deferredUsers: 1 })
    expect(h.writes.filter((item) => item.rpc === 'pjsdas_finish_gmail_execution').every((item) => Object.keys(item.data.state_patch as object).length === 0)).toBe(true)
    expect(h.writes.find((item) => item.rpc === 'pjsdas_finish_gmail_execution')?.data.metrics).toMatchObject({ errorCode: 'BUDGET_EXHAUSTED' })
  })
  it('uncertain finish never retries through an unfenced update or exposes raw error text', async () => {
    const h = harness({ finishLost: true }); const response = await h.invoke()
    expect(response.status).toBe(207)
    expect(h.writes.some((item) => item.rpc.endsWith('state_v2'))).toBe(false)
    expect(await response.text()).not.toContain('Synthetic lost response')
  })
  it('aggregates real source instants without message data and excludes invalid/future times', () => {
    expect(aggregateHistoryLag([999000,850000,0,NaN,2000000],1000000)).toEqual({ count:3,sumMs:1151000,maxMs:1000000,under2m:1,under15m:1,over15m:1 })
  })
})
