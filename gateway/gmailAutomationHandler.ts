import { createAutomationConnectionStore } from './automationConnectionStore.js'
import { runGmailAutomationForBinding } from './gmailAutomation.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface GmailAutomationHandlerConfig {
  supabaseUrl: string
  serviceRoleKey: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  automationSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
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
  const expectedSecret = config.automationSecret.trim()
  const store = createAutomationConnectionStore({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    fetchImpl: config.fetchImpl,
  })

  return async function handleGmailAutomation(request: Request) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' })
    }
    if (!expectedSecret) {
      return json(503, { code: 'AUTOMATION_NOT_CONFIGURED', message: 'PJSDAS automation secret is not configured.' })
    }
    if (bearer(request) !== expectedSecret) {
      return json(401, { code: 'AUTOMATION_AUTH_REQUIRED', message: 'PJSDAS automation authorization is required.' })
    }

    const url = new URL(request.url)
    const requestedUserId = url.searchParams.get('userId')?.trim()
    let bindings
    try {
      bindings = await store.listEnabledGmailBindings()
    } catch (caught) {
      const error = errorBody(caught)
      return json(error.retryable ? 503 : 500, error)
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
          historyId: run.nextHistoryId,
          checkedAt: run.checkedAt,
          successAt: run.checkedAt,
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
