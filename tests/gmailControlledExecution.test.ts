import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGmailAutomationHandler } from '../gateway/gmailAutomationHandler.js'
import { aggregateHistoryLag } from '../gateway/gmailExecutionMetrics.js'
import { GmailProviderRequestError } from '../gateway/gmailProviderFailure.js'
const state = vi.hoisted(() => ({ run: vi.fn(), reconcile: vi.fn() }))
vi.mock('../gateway/gmailAutomation.js', () => ({
  runGmailAutomationForBinding: state.run,
  runGmailReconciliationForBinding: state.reconcile,
}))
const row = { user_id: 'user', google_subject: 'subject', refresh_token_ciphertext: 'cipher', granted_scopes: [], gmail_history_id: 'list-old' }
const result = { coverageComplete: true, checkedAt: '2026-09-21T00:00:00Z', nextHistoryId: 'committed',
  metrics: { status: 'completed', mode: 'history', receivedCount: 1, accountedCount: 1, historyLag: { count: 1, sumMs: 1000, maxMs: 1000, under2m: 1, under15m: 0, over15m: 0 } } }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }
function harness(options: { coalesce?: boolean; assertValid?: boolean; budgetMs?: number; finishLost?: boolean; missingClaim?: boolean } = {}) {
  const writes: { rpc: string; data: Record<string, unknown> }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const rpc = String(input).split('/').at(-1)!; const data = JSON.parse(String(init?.body ?? '{}'))
    writes.push({ rpc, data })
    if (rpc === 'pjsdas_claim_gmail_automation_bindings_v4') return json([row, { ...row, user_id: 'later' }])
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
  const reconcile = () => handler(new Request('https://example.invalid/worker?userId=user&mode=reconcile', { headers: { authorization: 'Bearer synthetic-worker' } }))
  return { writes, invoke, reconcile }
}
beforeEach(() => {
  state.run.mockReset().mockImplementation(async (options) => { await options.execution.beforeWorkspaceWrite(); return result })
  state.reconcile.mockReset().mockImplementation(async (options) => {
    await options.execution.beforeWorkspaceWrite()
    return {
      checkedAt: '2026-09-26T00:30:00Z',
      metrics: { status: 'completed', mode: 'reconciliation', receivedCount: 3, accountedCount: 3, unresolvedCount: 0 },
      summary: { scannedCount: 3, recruitingRelevantCount: 1, actionableCount: 1, unresolvedCount: 0, gmailOnlyCount: 0, pjsdasOnlyCount: 1, fixedOrHardWithin7DaysCount: 1, liveProcessCount: 2, unavailableMessageCount: 0 },
    }
  })
})
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
  it('runs reconciliation under the same lease and finalizes without a primary cursor patch', async () => {
    const h = harness()
    const response = await h.reconcile()
    expect(response.status).toBe(200)
    expect(state.reconcile).toHaveBeenCalledTimes(1)
    expect(state.run).not.toHaveBeenCalled()
    const finish = h.writes.find((item) => item.rpc === 'pjsdas_finish_gmail_execution')!
    expect(finish.data.state_patch).toEqual({})
    expect(finish.data.metrics).toMatchObject({ mode: 'reconciliation', receivedCount: 3, accountedCount: 3 })
    await expect(response.json()).resolves.toMatchObject({
      successfulUsers: 1,
      results: [{ status: 'success', summary: { fixedOrHardWithin7DaysCount: 1 } }],
    })
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
  it('uses the reserved tail budget to finalize a successful run after the work timer expires', async () => {
    state.run.mockImplementation(async (options) => {
      await options.execution.beforeWorkspaceWrite()
      await new Promise((resolve) => setTimeout(resolve, 170))
      return result
    })
    const h = harness({ budgetMs: 200 })
    const response = await h.invoke()
    expect(response.status).toBe(200)
    const finish = h.writes.find((item) => item.rpc === 'pjsdas_finish_gmail_execution')!
    expect(finish.data.state_patch).toMatchObject({ historyId: 'committed', continuation: null })
    expect(finish.data.metrics).toMatchObject({ status: 'completed' })
  })
  it('budget aborts pending I/O, preserves cursor, and defers remaining bindings', async () => {
    state.run.mockImplementation(async (options) => { await options.fetchImpl('https://example.invalid/slow'); return result })
    const h = harness({ budgetMs: 100 }); const started = Date.now(); const response = await h.invoke(true)
    expect(Date.now()-started).toBeLessThan(1000)
    await expect(response.json()).resolves.toMatchObject({ failedUsers: 1, deferredUsers: 1 })
    expect(h.writes.filter((item) => item.rpc === 'pjsdas_finish_gmail_execution').every((item) => Object.keys(item.data.state_patch as object).length === 0)).toBe(true)
    expect(h.writes.find((item) => item.rpc === 'pjsdas_finish_gmail_execution')?.data.metrics).toMatchObject({ errorCode: 'BUDGET_EXHAUSTED' })
  })
  it('forwards only bounded provider diagnostics to controlled execution telemetry', async () => {
    state.run.mockRejectedValueOnce(new GmailProviderRequestError({
      code: 'GMAIL_REQUEST_FAILED',
      message: 'Gmail message fetch failed (HTTP 400).',
      retryable: false,
      operation: 'message_fetch',
      httpStatus: 400,
      providerReason: 'FAILED_PRECONDITION',
    }))
    const h = harness()
    const response = await h.invoke()
    expect(response.status).toBe(207)
    const finish = h.writes.find((item) => item.rpc === 'pjsdas_finish_gmail_execution')!
    expect(finish.data.state_patch).toEqual({})
    expect(finish.data.metrics).toMatchObject({
      status: 'error',
      errorCode: 'GMAIL_REQUEST_FAILED',
      providerOperation: 'message_fetch',
      providerStatus: 400,
      providerReason: 'FAILED_PRECONDITION',
      failureScope: 'run',
    })
    expect(JSON.stringify(finish.data.metrics)).not.toContain('Gmail message fetch failed')
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
