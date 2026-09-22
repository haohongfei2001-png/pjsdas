import { randomUUID } from 'node:crypto'
import { createAutomationConnectionStore } from './automationConnectionStore.js'
import { runGmailAutomationForBinding } from './gmailAutomation.js'
import type { GmailAutomationHandlerConfig } from './gmailAutomationHandler.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Opt-in only. Total budget includes claim, source work, commit and bounded cleanup. */
export async function runControlledGmailExecutions(config: GmailAutomationHandlerConfig, workerToken: string, requestedUserId?: string) {
  const limitMs = Math.max(50, Math.min(config.executionBudgetMs ?? 15_000, 15_000))
  const started = performance.now()
  const reserveMs = Math.min(1000, limitMs / 5)
  const workLimitMs = limitMs - reserveMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), workLimitMs)
  const remaining = () => limitMs - (performance.now() - started)
  const ensureBudget = () => {
    if (controller.signal.aborted || performance.now() - started >= workLimitMs) {
      throw new WorkspaceSourceError('BUDGET_EXHAUSTED', 'Gmail execution budget exhausted; continuation was preserved.', true)
    }
  }
  const rawFetch = config.fetchImpl ?? fetch
  const budgetFetch: typeof fetch = (input, init) => {
    ensureBudget()
    const priorSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    return rawFetch(input, { ...init, signal: priorSignal ? AbortSignal.any([controller.signal, priorSignal]) : controller.signal })
  }
  const storeOptions = { supabaseUrl: config.supabaseUrl, supabasePublishableKey: config.supabasePublishableKey, workerToken }
  const store = createAutomationConnectionStore({ ...storeOptions, fetchImpl: budgetFetch })
  const results: Array<{ status: 'success' | 'error'; code?: string }> = []
  let coalescedUsers = 0
  let deferredUsers = 0
  try {
    let bindings = await store.listEnabledGmailBindings()
    if (requestedUserId) bindings = bindings.filter((binding) => binding.userId === requestedUserId)
    for (const [index, listed] of bindings.entries()) {
      if (controller.signal.aborted || remaining() <= reserveMs + 50) { deferredUsers = bindings.length - index; break }
      const executionToken = randomUUID()
      let owned = false
      try {
        const binding = await store.beginGmailExecution(listed.userId, executionToken)
        if (!binding) { coalescedUsers += 1; continue }
        owned = true
        const run = await runGmailAutomationForBinding({ binding, tokenEncryptionKey: config.tokenEncryptionKey,
          googleClientId: config.googleClientId, googleClientSecret: config.googleClientSecret,
          fetchImpl: budgetFetch, now: config.now,
          execution: { beforeWorkspaceWrite: async () => {
            ensureBudget(); await store.assertGmailExecution(binding.userId, executionToken); ensureBudget()
          } },
        })
        if (remaining() <= 50) {
          throw new WorkspaceSourceError('BUDGET_EXHAUSTED', 'Gmail execution budget exhausted before finalization.', true)
        }
        const finishController = new AbortController()
        const finishTimer = setTimeout(() => finishController.abort(), Math.max(1, remaining()))
        const finishFetch: typeof fetch = (input, init) => {
          const priorSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
          return rawFetch(input, {
            ...init,
            signal: priorSignal ? AbortSignal.any([finishController.signal, priorSignal]) : finishController.signal,
          })
        }
        try {
          await createAutomationConnectionStore({ ...storeOptions, fetchImpl: finishFetch }).finishGmailExecution(
            binding.userId, executionToken, {
              ...(run.coverageComplete && run.nextHistoryId ? { historyId: run.nextHistoryId } : {}),
              continuation: run.coverageComplete ? null : run.continuation,
              ...(run.coverageComplete ? { successAt: run.checkedAt } : {}),
            }, run.metrics ?? { status: 'completed', mode: 'unknown' },
          )
        } finally {
          clearTimeout(finishTimer)
        }
        results.push({ status: 'success' })
      } catch (caught) {
        const code = controller.signal.aborted ? 'BUDGET_EXHAUSTED'
          : caught instanceof WorkspaceSourceError ? caught.code : 'AUTOMATION_FAILED'
        if (owned && remaining() > 0) {
          const cleanup = new AbortController()
          const cleanupTimer = setTimeout(() => cleanup.abort(), Math.max(1, remaining()))
          const cleanupFetch: typeof fetch = (input, init) => rawFetch(input, { ...init, signal: cleanup.signal })
          try {
            await createAutomationConnectionStore({ ...storeOptions, fetchImpl: cleanupFetch }).finishGmailExecution(
              listed.userId, executionToken, {}, { status: 'error', mode: 'unknown', errorCode: code })
          } catch { /* Lease expiration is the fail-closed recovery path. Never fall back to an unfenced state update. */ }
          finally { clearTimeout(cleanupTimer) }
        }
        results.push({ status: 'error', code })
      }
    }
    const failedUsers = results.filter((result) => result.status === 'error').length
    return { processedUsers: results.length, successfulUsers: results.length - failedUsers,
      failedUsers, coalescedUsers, deferredUsers, results }
  } finally { clearTimeout(timer) }
}
