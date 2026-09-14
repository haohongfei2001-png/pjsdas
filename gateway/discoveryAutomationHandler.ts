import { createAutomationConnectionStore } from './automationConnectionStore.js'
import {
  probeDiscoveryAiGateway,
  runDiscoveryAutomationForBinding,
  type DiscoveryGenerateText,
} from './discoveryAutomationWorker.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface DiscoveryAutomationHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  aiGatewayModel?: string
  generateTextImpl?: DiscoveryGenerateText
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
    code: 'DISCOVERY_AUTOMATION_FAILED',
    message: caught instanceof Error ? caught.message : 'PJSDAS discovery automation failed.',
    retryable: false,
  }
}

function compactError(caught: unknown) {
  const error = errorBody(caught)
  return `${error.code}: ${error.message}`.slice(0, 1200)
}

export function createDiscoveryAutomationHandler(config: DiscoveryAutomationHandlerConfig) {
  return async function handleDiscoveryAutomation(request: Request) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' })
    }
    const workerToken = bearer(request)
    if (!workerToken) {
      return json(401, { code: 'AUTOMATION_AUTH_REQUIRED', message: 'PJSDAS discovery automation authorization is required.' })
    }

    const store = createAutomationConnectionStore({
      supabaseUrl: config.supabaseUrl,
      supabasePublishableKey: config.supabasePublishableKey,
      workerToken,
      fetchImpl: config.fetchImpl,
    })
    const url = new URL(request.url)
    const requestedUserId = url.searchParams.get('userId')?.trim()
    const force = url.searchParams.get('force') === '1'
    const probe = url.searchParams.get('probe') === '1'
    let bindings
    try {
      bindings = await store.listDiscoveryBindings()
    } catch (caught) {
      const error = errorBody(caught)
      const status = error.code === 'AUTOMATION_AUTH_REQUIRED' ? 401 : error.retryable ? 503 : 500
      return json(status, error)
    }

    if (requestedUserId) bindings = bindings.filter((item) => item.userId === requestedUserId)

    if (probe) {
      try {
        const result = await probeDiscoveryAiGateway({
          model: config.aiGatewayModel,
          generateTextImpl: config.generateTextImpl,
        })
        return json(200, { probe: true, ...result })
      } catch (caught) {
        const error = errorBody(caught)
        return json(error.retryable ? 503 : 500, error)
      }
    }

    const results: Array<Record<string, unknown>> = []
    for (const binding of bindings) {
      try {
        const run = await runDiscoveryAutomationForBinding({
          binding,
          tokenEncryptionKey: config.tokenEncryptionKey,
          googleClientId: config.googleClientId,
          googleClientSecret: config.googleClientSecret,
          aiGatewayModel: config.aiGatewayModel,
          generateTextImpl: config.generateTextImpl,
          fetchImpl: config.fetchImpl,
          now: config.now,
          force,
        })
        await store.updateDiscoveryRunState(binding.userId, {
          checkedAt: run.checkedAt,
          successAt: run.checkedAt,
          lastError: null,
        })
        results.push({
          status: 'success',
          configured: run.configured,
          dueSourceCount: run.dueSourceCount,
          completedSourceCount: run.completedSourceCount,
          skippedSourceCount: run.skippedSourceCount,
          receivedCount: run.receivedCount,
          accountedCount: run.accountedCount,
          createdCount: run.createdCount,
          touchedCount: run.touchedCount,
          unresolvedCount: run.unresolvedCount,
        })
      } catch (caught) {
        const checkedAt = (config.now?.() ?? new Date()).toISOString()
        try {
          await store.updateDiscoveryRunState(binding.userId, {
            checkedAt,
            lastError: compactError(caught),
          })
        } catch {
          // Primary automation failure remains authoritative; telemetry is best-effort.
        }
        results.push({ status: 'error', ...errorBody(caught) })
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
