import { createAutomationConnectionStore, GMAIL_READONLY_SCOPE } from './automationConnectionStore.js'
import { fetchGmailSemanticRecordsByIds } from './gmailAutomation.js'
import { fragmentLimitReprocessTargetIds, reprocessVersion, type GmailFragmentReprocessDryRunConfig } from './gmailFragmentReprocessDryRunHandler.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { decryptSecret } from './tokenCrypto.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError } from './workspaceSource.js'
import { applyGmailSemanticBatch, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { stableIngestionHash } from '../src/ingestion.js'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'

const GMAIL_SOURCE_ID = 'gmail:primary'
const SETTLED_OUTCOMES = new Set(['ignored', 'resolved'])

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  })
}

function recordId(record: GmailSemanticRecord) {
  return record.observation.source.sourceRecordId
}

function settledIds(snapshot: PJSDASSnapshot, records: GmailSemanticRecord[], checkedAt: string, workspaceVersion: string) {
  if (!records.length) return new Set<string>()
  const ids = records.map(recordId).sort()
  const semantic = applyGmailSemanticBatch(snapshot, {
    runId: `gmail:fragment-reprocess-plan:${stableIngestionHash(`${workspaceVersion}|${ids.join('|')}`)}`,
    sourceId: GMAIL_SOURCE_ID,
    checkedAt,
    records,
    authorized: true,
    workspaceRevision: workspaceVersion,
    reconcileExisting: true,
  })
  const reconciled = reconcileIngestionDebt(semantic.snapshot, new Date(checkedAt), { maxRecords: 2000 })
  const candidateIds = new Set(ids)
  return new Set(reconciled.appended
    .filter((item) => item.ingestionResolution
      && item.ingestionResolution.sourceKind === 'gmail'
      && item.ingestionResolution.sourceId === GMAIL_SOURCE_ID
      && candidateIds.has(item.ingestionResolution.sourceRecordId)
      && SETTLED_OUTCOMES.has(item.ingestionResolution.outcome))
    .map((item) => item.ingestionResolution!.sourceRecordId))
}

/** Rebuild the selected settlement from the original snapshot; never commit a broad preview. */
export function planFragmentReprocessWrite(snapshot: PJSDASSnapshot, records: GmailSemanticRecord[], input: {
  checkedAt: string
  workspaceVersion: string
  targetIds: string[]
}) {
  const targetIds = new Set(input.targetIds)
  const complete = records.filter((record) => targetIds.has(recordId(record)) && record.gaps.length === 0)
  const projectedIds = settledIds(snapshot, complete, input.checkedAt, input.workspaceVersion)
  const selected = complete.filter((record) => projectedIds.has(recordId(record)))
  if (!selected.length) return { snapshot, selectedIds: [] as string[], compensation: undefined }

  const selectedIds = selected.map(recordId).sort()
  const semantic = applyGmailSemanticBatch(snapshot, {
    runId: `gmail:fragment-reprocess-write:${stableIngestionHash(`${input.workspaceVersion}|${selectedIds.join('|')}`)}`,
    sourceId: GMAIL_SOURCE_ID,
    checkedAt: input.checkedAt,
    records: selected,
    authorized: true,
    workspaceRevision: input.workspaceVersion,
    reconcileExisting: true,
  })
  if (semantic.alreadyApplied) {
    throw new WorkspaceSourceError('SETTLEMENT_PROJECTION_CHANGED', 'Selected fragment reprocess run was already applied.', false)
  }
  const reconciled = reconcileIngestionDebt(semantic.snapshot, new Date(input.checkedAt), { maxRecords: 2000 })
  const actualIds = new Set(reconciled.appended
    .filter((item) => item.ingestionResolution
      && item.ingestionResolution.sourceKind === 'gmail'
      && item.ingestionResolution.sourceId === GMAIL_SOURCE_ID
      && projectedIds.has(item.ingestionResolution.sourceRecordId)
      && SETTLED_OUTCOMES.has(item.ingestionResolution.outcome))
    .map((item) => item.ingestionResolution!.sourceRecordId))
  const openDecisionIds = new Set((reconciled.snapshot.data.decisionRequests ?? [])
    .filter((item) => item.payloadBinding.source.kind === 'gmail'
      && item.payloadBinding.source.sourceId === GMAIL_SOURCE_ID
      && (item.state === 'open' || item.state === 'expired'))
    .map((item) => item.payloadBinding.source.sourceRecordId))
  if (actualIds.size !== selectedIds.length
    || selectedIds.some((id) => !actualIds.has(id) || openDecisionIds.has(id))) {
    throw new WorkspaceSourceError('SETTLEMENT_PROJECTION_CHANGED', 'Selected fragment records did not remain conclusively settled.', false)
  }
  const selectedSet = new Set(selectedIds)
  const unrelatedResolutionIds = new Set(reconciled.appended
    .filter((item) => !item.ingestionResolution
      || item.ingestionResolution.sourceKind !== 'gmail'
      || item.ingestionResolution.sourceId !== GMAIL_SOURCE_ID
      || !selectedSet.has(item.ingestionResolution.sourceRecordId))
    .map((item) => item.id))
  const boundedSnapshot = structuredClone(reconciled.snapshot)
  boundedSnapshot.data.timeline = (boundedSnapshot.data.timeline ?? []).filter((item) => !unrelatedResolutionIds.has(item.id))
  validateSnapshot(boundedSnapshot)
  return { snapshot: boundedSnapshot, selectedIds, compensation: semantic.compensation }
}

/** Explicit one-shot production write. No scheduler or dry-run route calls this handler. */
export function createGmailFragmentReprocessWriteHandler(config: GmailFragmentReprocessDryRunConfig) {
  return async function handle(request: Request) {
    if (request.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED' })
    if (new URL(request.url).searchParams.get('write') !== '1') {
      return json(409, { code: 'EXPLICIT_WRITE_REQUIRED' })
    }
    const workerToken = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1]?.trim()
    if (!workerToken) return json(401, { code: 'AUTOMATION_AUTH_REQUIRED' })
    const body = await request.json().catch(() => undefined) as {
      expectedRevision?: unknown; expectedProjectedSettledCount?: unknown
    } | undefined
    if (!Number.isSafeInteger(body?.expectedRevision) || Number(body?.expectedRevision) < 0
      || !Number.isSafeInteger(body?.expectedProjectedSettledCount)
      || Number(body?.expectedProjectedSettledCount) < 1) {
      return json(400, { code: 'EXACT_PROJECTION_REQUIRED' })
    }

    try {
      const store = createAutomationConnectionStore({
        supabaseUrl: config.supabaseUrl,
        supabasePublishableKey: config.supabasePublishableKey,
        workerToken,
        fetchImpl: config.fetchImpl,
      })
      const bindings = await store.listEnabledGmailBindings()
      if (bindings.length !== 1) {
        throw new WorkspaceSourceError('BINDING_COUNT_CHANGED', 'Expected exactly one enabled Gmail binding.', false)
      }
      const binding = bindings[0]!
      if (binding.gmailIntakeConsentVersion !== 'uu06-v1'
        || !binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
        throw new WorkspaceSourceError('GOOGLE_GMAIL_SCOPE_MISSING', 'Gmail read-only consent is missing.', false)
      }
      const source = createTransactionalWorkspaceSource({
        userId: binding.userId,
        supabaseUrl: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
        principalKind: 'automation',
        sourceId: 'gmail-fragment-reprocess-write',
        timezone: 'Asia/Shanghai',
        fetchImpl: config.fetchImpl,
        now: config.now,
      })
      const workspace = await source.read()
      const expectedVersion = `txn:${body!.expectedRevision}`
      if (workspace.context.workspaceVersion !== expectedVersion) {
        throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Workspace revision changed since the approved dry-run.', true)
      }
      const targets = fragmentLimitReprocessTargetIds(workspace.snapshot)
      const maxRecords = Math.max(1, Math.min(config.maxRecords ?? 100, 100))
      if (targets.length > maxRecords) {
        throw new WorkspaceSourceError('GMAIL_FRAGMENT_REPROCESS_LIMIT_EXCEEDED', 'Fragment target count exceeds the bounded limit.', false)
      }
      if (!targets.length) throw new WorkspaceSourceError('SETTLEMENT_PROJECTION_CHANGED', 'No eligible fragment targets remain.', false)
      const refreshToken = await decryptSecret(binding.refreshTokenCiphertext, config.tokenEncryptionKey)
      const accessToken = await refreshGoogleAccessToken(refreshToken, {
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
      const plan = planFragmentReprocessWrite(workspace.snapshot, parsed.records.map(reprocessVersion), {
        checkedAt: now.toISOString(), workspaceVersion: expectedVersion, targetIds: targets,
      })
      if (plan.selectedIds.length !== body!.expectedProjectedSettledCount) {
        throw new WorkspaceSourceError('SETTLEMENT_PROJECTION_CHANGED', 'Settlement count changed since the approved dry-run.', false)
      }
      const written = await requireWritableWorkspaceSource(source).write({
        snapshot: plan.snapshot,
        expectedWorkspaceVersion: expectedVersion,
        updatedByDevice: 'gmail-fragment-reprocess-write',
        command: {
          commandId: `gmail:fragment-reprocess-write:${body!.expectedRevision}:${stableIngestionHash(plan.selectedIds.join('|'))}`,
          operation: 'gmail_fragment_reprocess_settlement',
          payload: { sourceId: GMAIL_SOURCE_ID, selectedIds: plan.selectedIds },
          provenance: { sourceId: GMAIL_SOURCE_ID, adapterVersion: 'fragment-reprocess-write-v1' },
          compensation: plan.compensation ? { ...plan.compensation } : undefined,
          effectiveTime: now.toISOString(),
        },
      })
      return json(200, {
        status: 'committed',
        selectedCount: plan.selectedIds.length,
        workspaceRevisionBefore: body!.expectedRevision,
        workspaceVersionAfter: written.context.workspaceVersion,
      })
    } catch (caught) {
      const code = caught instanceof WorkspaceSourceError ? caught.code : 'AUTOMATION_FAILED'
      return json(code === 'AUTOMATION_AUTH_REQUIRED' ? 401
        : code === 'WORKSPACE_CONFLICT' || code === 'SETTLEMENT_PROJECTION_CHANGED' ? 409 : 500, { code })
    }
  }
}
