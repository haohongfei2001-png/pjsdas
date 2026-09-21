import { runControlledGmailExecutions } from './gmailControlledExecution.js'
import { createAutomationConnectionStore } from './automationConnectionStore.js'
import { runGmailAutomationForBinding } from './gmailAutomation.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface GmailAutomationHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
  executionControlsEnabled?: boolean
  executionBudgetMs?: number
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

function bearer(request: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')
  return match?.[1]?.trim() ?? ''
}

function errorBody(caught: unknown) {
  if (caught instanceof WorkspaceSourceError) {
    return { code: caught.code, message: caught.message, retryable: caught.retryable }
  }
  return {
    code: 'AUTOMATION_FAILED',
    message: caught instanceof Error ? caught.message : 'PJSDAS Gmail automation failed.',
    retryable: false,
  }
}

function compactError(caught: unknown) {
  const error = errorBody(caught)
  return `${error.code}: ${error.message}`.slice(0, 1200)
}

export function createGmailAutomationHandler(config: GmailAutomationHandlerConfig) {
  return async function handleGmailAutomation(request: Request) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' })
    }
    const workerToken = bearer(request)
    if (!workerToken) {
      return json(401, { code: 'AUTOMATION_AUTH_REQUIRED', message: 'PJSDAS automation authorization is required.' })
    }

    if (config.executionControlsEnabled === true) {
      try {
        const result = await runControlledGmailExecutions(config, workerToken, new URL(request.url).searchParams.get('userId')?.trim())
        return json(result.failedUsers ? 207 : 200, result)
      } catch (caught) {
        const error = errorBody(caught)
        return json(error.code === 'AUTOMATION_AUTH_REQUIRED' ? 401 : 503, { code: error.code, retryable: error.retryable })
      }
    }

    const store = createAutomationConnectionStore({
      supabaseUrl: config.supabaseUrl,
      supabasePublishableKey: config.supabasePublishableKey,
      workerToken,
      fetchImpl: config.fetchImpl,
    })
    const url = new URL(request.url)
    const requestedUserId = url.searchParams.get('userId')?.trim()
    let bindings
    try {
      bindings = await store.listEnabledGmailBindings()
    } catch (caught) {
      const error = errorBody(caught)
      const status = error.code === 'AUTOMATION_AUTH_REQUIRED' ? 401 : error.retryable ? 503 : 500
      return json(status, error)
    }
    if (requestedUserId) bindings = bindings.filter((item) => item.userId === requestedUserId)

    const results: Array<Record<string, unknown>> = []
    for (const binding of bindings) {
      try {
        const run = await runGmailAutomationForBinding({
          binding,
          tokenEncryptionKey: config.tokenEncryptionKey,
          googleClientId: config.googleClientId,
          googleClientSecret: config.googleClientSecret,
          fetchImpl: config.fetchImpl,
          now: config.now,
        })
        await store.updateGmailRunState(binding.userId, {
          ...(run.coverageComplete && run.nextHistoryId ? { historyId: run.nextHistoryId } : {}),
          continuation: run.coverageComplete ? null : run.continuation,
          checkedAt: run.checkedAt,
          ...(run.coverageComplete ? { successAt: run.checkedAt } : {}),
          lastError: null,
        })
        results.push({ status: 'success', ...run })
      } catch (caught) {
        const checkedAt = (config.now?.() ?? new Date()).toISOString()
        try {
          await store.updateGmailRunState(binding.userId, {
            checkedAt,
            lastError: compactError(caught),
          })
        } catch {
          // The primary automation error remains authoritative; state telemetry is best-effort.
        }
        results.push({
          status: 'error',
          userId: binding.userId,
          ...errorBody(caught),
        })
      }
    }

    const failures = results.filter((item) => item.status === 'error').length
    return json(failures > 0 ? 207 : 200, {
      processedUsers: results.length,
      successfulUsers: results.length - failures,
      failedUsers: failures,
      results,
    })
  }
}
