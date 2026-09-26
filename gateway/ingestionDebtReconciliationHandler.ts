import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { stableIngestionHash } from '../src/ingestion.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export interface IngestionDebtReconciliationHandlerConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  supabaseServiceRoleKey: string
  fetchImpl?: typeof fetch
  now?: () => Date
  maxUsers?: number
  maxRecordsPerWorkspace?: number
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

async function reconciliationUsers(config: IngestionDebtReconciliationHandlerConfig, workerToken: string) {
  const fetchImpl = config.fetchImpl ?? fetch
  const response = await fetchImpl(
    `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/pjsdas_claim_ingestion_reconciliation_users`,
    {
      method: 'POST',
      headers: {
        apikey: config.supabasePublishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ worker_token: workerToken }),
    },
  )
  if (response.status === 401 || response.status === 403) {
    throw new WorkspaceSourceError('AUTOMATION_AUTH_REQUIRED', 'TodayAction reconciliation worker authorization is invalid.', false)
  }
  if (response.status === 404) {
    throw new WorkspaceSourceError('AUTOMATION_RPC_NOT_DEPLOYED', 'TodayAction ingestion reconciliation contract is not deployed.', false)
  }
  if (!response.ok) {
    throw new WorkspaceSourceError('AUTH_UNAVAILABLE', 'TodayAction reconciliation target store is temporarily unavailable.', true)
  }
  const rows = await response.json().catch(() => undefined) as Array<{ user_id?: string }> | undefined
  if (!Array.isArray(rows)) {
    throw new WorkspaceSourceError('AUTH_INVALID', 'TodayAction reconciliation target store returned invalid data.', false)
  }
  const users = rows.flatMap((row) => typeof row.user_id === 'string' && row.user_id.trim() ? [row.user_id] : [])
  const maxUsers = Math.max(1, Math.min(config.maxUsers ?? 10, 50))
  if (users.length > maxUsers) {
    throw new WorkspaceSourceError(
      'AUTOMATION_LIMIT_EXCEEDED',
      `TodayAction ingestion reconciliation found more than ${maxUsers} workspaces in one bounded run.`,
      true,
    )
  }
  return users
}

export function createIngestionDebtReconciliationHandler(config: IngestionDebtReconciliationHandlerConfig) {
  return async function handle(request: Request) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' })
    }
    const workerToken = bearer(request)
    const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'
    if (!workerToken) {
      return json(401, { code: 'AUTOMATION_AUTH_REQUIRED', message: 'TodayAction automation authorization is required.' })
    }

    let users: string[]
    try {
      users = await reconciliationUsers(config, workerToken)
    } catch (caught) {
      const code = caught instanceof WorkspaceSourceError ? caught.code : 'AUTOMATION_FAILED'
      const retryable = caught instanceof WorkspaceSourceError ? caught.retryable : false
      return json(code === 'AUTOMATION_AUTH_REQUIRED' ? 401 : retryable ? 503 : 500, { code, retryable })
    }

    const results: Array<{
      status: 'success' | 'error'
      changed?: boolean
      evaluatedUnresolvedKeys?: number
      appendedResolutionCount?: number
      resolutionOutcomeCounts?: Record<string, number>
      code?: string
    }> = []

    for (const userId of users) {
      try {
        const source = createTransactionalWorkspaceSource({
          userId,
          supabaseUrl: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          principalKind: 'automation',
          sourceId: 'ingestion-debt-reconciliation',
          timezone: 'Asia/Shanghai',
          fetchImpl: config.fetchImpl,
          now: config.now,
        })
        const workspace = await source.read()
        const now = config.now?.() ?? new Date()
        const result = reconcileIngestionDebt(workspace.snapshot, now, {
          maxRecords: config.maxRecordsPerWorkspace ?? 2000,
        })
        if (!result.changed) {
          results.push({
            status: 'success',
            changed: false,
            evaluatedUnresolvedKeys: result.evaluatedUnresolvedKeys,
            appendedResolutionCount: 0,
          })
          continue
        }

        const resolutionIds = result.appended.map((item) => item.id).sort()
        const resolutionOutcomeCounts: Record<string, number> = {}
        for (const item of result.appended) {
          const outcome = item.ingestionResolution?.outcome
          if (outcome) resolutionOutcomeCounts[outcome] = (resolutionOutcomeCounts[outcome] ?? 0) + 1
        }
        if (dryRun) {
          results.push({
            status: 'success',
            changed: true,
            evaluatedUnresolvedKeys: result.evaluatedUnresolvedKeys,
            appendedResolutionCount: result.appended.length,
            resolutionOutcomeCounts,
          })
          continue
        }

        await source.write({
          snapshot: result.snapshot,
          expectedWorkspaceVersion: workspace.context.workspaceVersion,
          updatedByDevice: 'ingestion-debt-reconciliation-worker',
          command: {
            commandId: `ingestion-debt-reconcile:${stableIngestionHash(resolutionIds.join('|'))}`,
            operation: 'ingestion_debt_reconciliation',
            payload: {
              evaluatedUnresolvedKeys: result.evaluatedUnresolvedKeys,
              resolutionIds,
            },
            provenance: {
              sourceId: 'ingestion-debt-reconciliation',
              adapterVersion: 'active-unresolved-v1',
            },
            effectiveTime: now.toISOString(),
          },
        })
        results.push({
          status: 'success',
          changed: true,
          evaluatedUnresolvedKeys: result.evaluatedUnresolvedKeys,
          appendedResolutionCount: result.appended.length,
          resolutionOutcomeCounts,
        })
      } catch (caught) {
        const code = caught instanceof WorkspaceSourceError ? caught.code : 'AUTOMATION_FAILED'
        results.push({ status: 'error', code })
      }
    }

    const failedUsers = results.filter((item) => item.status === 'error').length
    return json(failedUsers ? 207 : 200, {
      dryRun,
      processedWorkspaces: results.length,
      successfulWorkspaces: results.length - failedUsers,
      failedWorkspaces: failedUsers,
      changedWorkspaces: results.filter((item) => item.changed).length,
      appendedResolutionCount: results.reduce((sum, item) => sum + (item.appendedResolutionCount ?? 0), 0),
      results,
    })
  }
}
