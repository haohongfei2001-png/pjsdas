import { automationGoogleRefreshLifecycle } from './googleRefreshLifecycle.js'
import { createAutomationConnectionStore, GMAIL_READONLY_SCOPE } from './automationConnectionStore.js'
import {
  fetchGmailSemanticRecordsByIds,
  GMAIL_FRAGMENT_PARSE_LIMIT,
  gmailReconciliationStateForRecord,
} from './gmailAutomation.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { decryptSecret } from './tokenCrypto.js'
import { WorkspaceSourceError } from './workspaceSource.js'
import { applyGmailSemanticBatch, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { stableIngestionHash, summarizeCoverage } from '../src/ingestion.js'
import type { GmailReconciliationState, TimelineRecord } from '../src/model.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import { fragmentBindingShape, fragmentBusinessDeltaDigest, fragmentEvidenceShape, fragmentSafetyDigest } from '../src/fragmentReprocessSafety.js'
import { planFragmentReprocessWrite } from './gmailFragmentReprocessWriteHandler.js'

const GMAIL_SOURCE_ID = 'gmail:primary'
const FRAGMENT_REPROCESS_SOURCE_VERSION = 'fragment-reprocess-v2'
const LEGACY_FRAGMENT_REASON = '20-fragment interpretation limit'

export interface GmailFragmentReprocessDryRunConfig {
  supabaseUrl: string
  supabasePublishableKey: string
  supabaseServiceRoleKey: string
  tokenEncryptionKey: string
  googleClientId: string
  googleClientSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
  maxUsers?: number
  maxRecords?: number
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

function sourceKey(record: TimelineRecord) {
  const resolution = record.ingestionResolution
  return resolution
    ? `${resolution.sourceKind}|${resolution.sourceId}|${resolution.sourceRecordId}`
    : ''
}

function latestResolutionRecords(snapshot: PJSDASSnapshot) {
  const latest = new Map<string, TimelineRecord>()
  for (const record of snapshot.data.timeline ?? []) {
    if (!record.ingestionResolution) continue
    const key = sourceKey(record)
    const prior = latest.get(key)
    const priorAt = prior?.ingestionResolution?.reconciledAt ?? ''
    if (!prior || priorAt <= record.ingestionResolution.reconciledAt) latest.set(key, record)
  }
  return latest
}

export function fragmentLimitReprocessTargetIds(snapshot: PJSDASSnapshot) {
  const timeline = snapshot.data.timeline ?? []
  const byId = new Map(timeline.map((record) => [record.id, record]))
  const ids = new Set<string>()
  for (const resolutionRecord of latestResolutionRecords(snapshot).values()) {
    const resolution = resolutionRecord.ingestionResolution!
    if (resolution.outcome !== 'active_unresolved' || resolution.reason !== 'unlinked_unresolved') continue
    const target = byId.get(resolution.targetIngestionTimelineId)
    const ingestion = target?.ingestion
    if (!ingestion
      || ingestion.sourceKind !== 'gmail'
      || ingestion.sourceId !== GMAIL_SOURCE_ID
      || !ingestion.reason?.includes(LEGACY_FRAGMENT_REASON)) continue
    ids.add(ingestion.sourceRecordId)
  }
  return [...ids].sort()
}

export function reprocessVersion(record: GmailSemanticRecord): GmailSemanticRecord {
  const sourceRecordId = record.observation.source.sourceRecordId
  return {
    ...record,
    observation: {
      ...record.observation,
      inputId: `gmail:${sourceRecordId}:${FRAGMENT_REPROCESS_SOURCE_VERSION}`,
      source: {
        ...record.observation.source,
        sourceVersion: FRAGMENT_REPROCESS_SOURCE_VERSION,
      },
      candidates: record.observation.candidates.map((candidate) => ({
        ...candidate,
        sourceVersionRefs: [`${sourceRecordId}:${FRAGMENT_REPROCESS_SOURCE_VERSION}`],
      })),
    },
  }
}

function stateCounts(records: GmailSemanticRecord[]) {
  const counts: Record<GmailReconciliationState, number> = {
    NO_ACTION: 0,
    WAITING: 0,
    ACTION_REQUIRED: 0,
    COMPLETED: 0,
    EXPLICITLY_DECLINED: 0,
    CLOSED: 0,
    UNRESOLVED: 0,
  }
  for (const record of records) {
    const state = gmailReconciliationStateForRecord(record)
    if (state) counts[state] += 1
  }
  return counts
}

export function createGmailFragmentReprocessDryRunHandler(config: GmailFragmentReprocessDryRunConfig) {
  return async function handle(request: Request) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' })
    }
    const url = new URL(request.url)
    if (url.searchParams.get('dryRun') !== '1') {
      return json(409, {
        code: 'DRY_RUN_REQUIRED',
        message: 'Fragment-limit reprocessing is read-only in this package phase.',
      })
    }
    const workerToken = bearer(request)
    if (!workerToken) {
      return json(401, { code: 'AUTOMATION_AUTH_REQUIRED', message: 'TodayAction automation authorization is required.' })
    }

    try {
      const store = createAutomationConnectionStore({
        supabaseUrl: config.supabaseUrl,
        supabasePublishableKey: config.supabasePublishableKey,
        workerToken,
        supabaseServiceRoleKey: config.supabaseServiceRoleKey,
        refreshSource: 'gmail',
        fetchImpl: config.fetchImpl,
      })
      let bindings = await store.listEnabledGmailBindings()
      const requestedUserId = url.searchParams.get('userId')?.trim()
      if (requestedUserId) bindings = bindings.filter((binding) => binding.userId === requestedUserId)
      const maxUsers = Math.max(1, Math.min(config.maxUsers ?? 10, 20))
      if (bindings.length > maxUsers) {
        throw new WorkspaceSourceError(
          'AUTOMATION_LIMIT_EXCEEDED',
          `Fragment-limit dry-run found more than ${maxUsers} enabled Gmail bindings.`,
          true,
        )
      }

      const results: Array<Record<string, unknown>> = []
      for (const binding of bindings) {
        if (binding.gmailIntakeConsentVersion !== 'uu06-v1'
          || !binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
          results.push({ status: 'error', code: 'GOOGLE_GMAIL_SCOPE_MISSING' })
          continue
        }

        const source = createTransactionalWorkspaceSource({
          userId: binding.userId,
          supabaseUrl: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
          principalKind: 'automation',
          sourceId: 'gmail-fragment-reprocess-dry-run',
          timezone: 'Asia/Shanghai',
          fetchImpl: config.fetchImpl,
          now: config.now,
        })
        const workspace = await source.read()
        const targets = fragmentLimitReprocessTargetIds(workspace.snapshot)
        const maxRecords = Math.max(1, Math.min(config.maxRecords ?? 100, 100))
        if (targets.length > maxRecords) {
          throw new WorkspaceSourceError(
            'GMAIL_FRAGMENT_REPROCESS_LIMIT_EXCEEDED',
            `Fragment-limit dry-run found more than ${maxRecords} target source records.`,
            false,
          )
        }

        if (!targets.length) {
          results.push({
            status: 'success',
            targetedCount: 0,
            fetchedCount: 0,
            unavailableCount: 0,
            parserCompleteCount: 0,
            projectedSettledCount: 0,
            projectedActiveUnresolved: summarizeCoverage(workspace.snapshot.data.timeline).activeUnresolvedCount,
          })
          continue
        }

        const refreshToken = await decryptSecret(binding.refreshTokenCiphertext, config.tokenEncryptionKey)
        const accessToken = await refreshGoogleAccessToken(refreshToken, {
          ...automationGoogleRefreshLifecycle(config.tokenEncryptionKey, binding, store),
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          fetchImpl: config.fetchImpl,
        })
        const now = config.now?.() ?? new Date()
        const parsed = await fetchGmailSemanticRecordsByIds({
          accessToken,
          messageIds: targets,
          opportunities: workspace.snapshot.data.opportunities,
          fetchImpl: config.fetchImpl,
          now,
        })
        const records = parsed.records.map(reprocessVersion)
        const completeRecords = records.filter((record) => record.gaps.length === 0)
        const stillBounded = records.filter((record) =>
          record.gaps.some((gap) => gap.includes(`${GMAIL_FRAGMENT_PARSE_LIMIT}-fragment interpretation limit`)))
        const parserStates = stateCounts(records)
        const beforeCoverage = summarizeCoverage(workspace.snapshot.data.timeline)
        const boundedPlan = planFragmentReprocessWrite(workspace.snapshot, records, {
          checkedAt: now.toISOString(), workspaceVersion: workspace.context.workspaceVersion ?? '', targetIds: targets,
        })

        let projectedSettledCount = 0
        let projectedActiveUnresolved = beforeCoverage.activeUnresolvedCount
        let semanticReceiptCounts: Record<string, number> = {}
        let projectedResolutionOutcomeCounts: Record<string, number> = {}
        const projectedSettledIds = new Set<string>()

        if (completeRecords.length) {
          const sortedIds = completeRecords.map((record) => record.observation.source.sourceRecordId).sort()
          const semantic = applyGmailSemanticBatch(workspace.snapshot, {
            runId: `gmail:fragment-reprocess-dryrun:${stableIngestionHash(sortedIds.join('|'))}`,
            sourceId: GMAIL_SOURCE_ID,
            checkedAt: now.toISOString(),
            records: completeRecords,
            authorized: true,
            workspaceRevision: workspace.context.workspaceVersion,
            reconcileExisting: true,
          })
          const targetSet = new Set(targets)
          for (const receipt of semantic.snapshot.data.semanticReceipts ?? []) {
            if (receipt.sourceVersion !== FRAGMENT_REPROCESS_SOURCE_VERSION || !targetSet.has(receipt.sourceRecordId)) continue
            semanticReceiptCounts[receipt.status] = (semanticReceiptCounts[receipt.status] ?? 0) + 1
          }

          const reconciled = reconcileIngestionDebt(semantic.snapshot, now, { maxRecords: 2000 })
          for (const item of reconciled.appended) {
            const resolution = item.ingestionResolution
            if (!resolution || !targetSet.has(resolution.sourceRecordId)) continue
            projectedResolutionOutcomeCounts[resolution.outcome] =
              (projectedResolutionOutcomeCounts[resolution.outcome] ?? 0) + 1
            if (resolution.outcome === 'ignored' || resolution.outcome === 'resolved') {
              projectedSettledCount += 1
              projectedSettledIds.add(resolution.sourceRecordId)
            }
          }
          projectedActiveUnresolved = Math.max(0, beforeCoverage.activeUnresolvedCount - projectedSettledCount)
        }
        if (boundedPlan.selectedIds.length !== projectedSettledCount
          || boundedPlan.selectedIds.some((id) => !projectedSettledIds.has(id))) {
          throw new WorkspaceSourceError('SETTLEMENT_PROJECTION_CHANGED', 'Read-only and bounded projections disagree.', false)
        }

        results.push({
          status: 'success',
          targetedCount: targets.length,
          fetchedCount: parsed.fetchedCount,
          unavailableCount: parsed.unavailableCount,
          parserCompleteCount: completeRecords.length,
          parserGapCount: records.length - completeRecords.length,
          newFragmentCeilingCount: stillBounded.length,
          parserStates,
          semanticReceiptCounts,
          projectedResolutionOutcomeCounts,
          projectedSettledCount,
          activeUnresolvedBefore: beforeCoverage.activeUnresolvedCount,
          projectedActiveUnresolved,
          bindingDigest: await fragmentSafetyDigest(fragmentBindingShape(binding)),
          targetSetDigest: await fragmentSafetyDigest(targets),
          evidenceDigest: await fragmentSafetyDigest(fragmentEvidenceShape(records)),
          settledSetDigest: await fragmentSafetyDigest(boundedPlan.selectedIds),
          businessDeltaDigest: await fragmentBusinessDeltaDigest(
            workspace.snapshot, boundedPlan.snapshot, now.toISOString()),
        })
      }

      const failed = results.filter((result) => result.status === 'error').length
      return json(failed ? 207 : 200, {
        dryRun: true,
        processedBindings: results.length,
        failedBindings: failed,
        results,
      })
    } catch (caught) {
      const code = caught instanceof WorkspaceSourceError ? caught.code : 'AUTOMATION_FAILED'
      const retryable = caught instanceof WorkspaceSourceError ? caught.retryable : false
      return json(
        code === 'AUTOMATION_AUTH_REQUIRED' ? 401 : retryable ? 503 : 500,
        { code, retryable },
      )
    }
  }
}
