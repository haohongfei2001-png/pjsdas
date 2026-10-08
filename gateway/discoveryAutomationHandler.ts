import { automationGoogleRefreshLifecycle } from './googleRefreshLifecycle.js'
import type { ReserveDiscoverySpend } from './discoveryBudgetGuard.js'
import type { DiscoverySearchProvider, ReserveDiscoverySearch } from './discoverySearchExecution.js'
import { createAutomationConnectionStore } from './automationConnectionStore.js'
import {
  probeDiscoveryAiGateway,
  runDiscoveryAutomationForBinding,
  type DiscoveryGenerateText,
  type DiscoveryAutomationRunResult,
} from './discoveryAutomationWorker.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface DiscoveryAutomationHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  supabaseServiceRoleKey?: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  aiGatewayModel?: string
  budgetPolicyVersion?: string
  generateTextImpl?: DiscoveryGenerateText
  reserveSpend?: ReserveDiscoverySpend
  searchProvider?: DiscoverySearchProvider
  reserveSearch?: ReserveDiscoverySearch
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

export function discoveryAutomationTelemetryPatch(run: DiscoveryAutomationRunResult) {
  return {
    checkedAt: run.checkedAt,
    ...((run.successfulSourceCount ?? run.completedSourceCount) > 0 ? { successAt: run.completedAt ?? run.checkedAt } : {}),
    lastError: run.failedSourceCount || run.partialSourceCount || run.readbackPendingCount
      ? `DISCOVERY_PARTIAL: ${run.failedSourceCount ?? 0} source failures; ${run.partialSourceCount ?? 0} partial searches; ${run.readbackPendingCount ?? 0} pending readbacks; ${run.remainingQueryCount ?? 0} uncovered queries; ${run.uncertainSourceCount ?? 0} uncertain batches; budget_exhausted=${Boolean(run.budgetExhausted)}.`
      : null,
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
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
      refreshSource: 'discovery',
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
          reserveSpend: config.reserveSpend,
          budgetAccountId: bindings.length === 1 ? bindings[0].userId : undefined,
          budgetSourceId: 'discovery:probe',
          clock: config.now,
          authorize: async () => {
            if (bindings.length !== 1) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'A model probe requires one admitted automation binding.', false)
            const admitted = bindings[0], active = (await store.listDiscoveryBindings()).find(item => item.userId === admitted.userId)
            if (!active || !admitted.discoveryConsentGeneration || active.discoveryConsentGeneration !== admitted.discoveryConsentGeneration
              || active.googleSubject !== admitted.googleSubject) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Automation consent changed before the model probe.', false)
          },
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
          refreshLifecycle: { ...automationGoogleRefreshLifecycle(config.tokenEncryptionKey, binding, store) },
          tokenEncryptionKey: config.tokenEncryptionKey,
          googleClientId: config.googleClientId,
          googleClientSecret: config.googleClientSecret,
          aiGatewayModel: config.aiGatewayModel,
          budgetPolicyVersion: config.budgetPolicyVersion,
          generateTextImpl: config.generateTextImpl,
          reserveSpend: config.reserveSpend,
          searchProvider: config.searchProvider,
          reserveSearch: config.reserveSearch,
          authorize: async () => {
            const active = (await store.listDiscoveryBindings()).find(item => item.userId === binding.userId)
            if (!active || !binding.discoveryConsentGeneration || active.discoveryConsentGeneration !== binding.discoveryConsentGeneration
              || active.googleSubject !== binding.googleSubject) {
              throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery consent was revoked, replaced or changed after this run was admitted.', false)
            }
          },
          fetchImpl: config.fetchImpl,
          now: config.now,
          force,
        })
        const durableCommit = run.completedSourceCount > 0
        await store.updateDiscoveryRunState(binding.userId, discoveryAutomationTelemetryPatch(run), binding.refreshTokenCiphertext)
        results.push({
          status: run.state,
          producer: run.producer,
          durableCommit,
          configured: run.configured,
          dueSourceCount: run.dueSourceCount,
          completedSourceCount: run.completedSourceCount,
          skippedSourceCount: run.skippedSourceCount,
          receivedCount: run.receivedCount,
          accountedCount: run.accountedCount,
          createdCount: run.createdCount,
          touchedCount: run.touchedCount,
          unresolvedCount: run.unresolvedCount,
          failedSourceCount: run.failedSourceCount ?? 0,
          partialSourceCount: run.partialSourceCount ?? 0,
          successfulSourceCount: run.successfulSourceCount ?? run.completedSourceCount,
          readbackPendingCount: run.readbackPendingCount ?? 0,
          sourceErrors: run.sourceErrors ?? [],
          totalQueryCount: run.totalQueryCount ?? 0,
          remainingQueryCount: run.remainingQueryCount ?? 0,
          uncertainSourceCount: run.uncertainSourceCount ?? 0,
          budgetExhausted: run.budgetExhausted ?? false,
          scopeComplete: run.scopeComplete ?? false,
        })
      } catch (caught) {
        const checkedAt = (config.now?.() ?? new Date()).toISOString()
        try {
          // Preflight rejects incomplete scope before any search, reservation
          // or persistent run-state write. The response still carries its error.
          if (!(caught instanceof WorkspaceSourceError && caught.code === 'DISCOVERY_SCOPE_INCOMPLETE')) {
            await store.updateDiscoveryRunState(binding.userId, {
              checkedAt,
              lastError: compactError(caught),
            }, binding.refreshTokenCiphertext)
          }
        } catch {
          // Primary automation failure remains authoritative; telemetry is best-effort.
        }
        results.push({ status: 'failed', producer: 'server_scheduler', durableCommit: false, ...errorBody(caught) })
      }
    }

    const failures = results.filter((item) => item.status === 'failed' || item.status === 'retrieval_failed').length
    const durableCompletedUsers = results.filter((item) => item.durableCommit === true).length
    return json(failures > 0 ? 207 : 200, {
      processedUsers: results.length,
      checkedUsers: results.length - failures,
      successfulUsers: results.filter(item => item.status === 'committed').length,
      partialUsers: results.filter(item => item.status === 'committed_with_exceptions').length,
      durableCompletedUsers,
      failedUsers: failures,
      results,
    })
  }
}
