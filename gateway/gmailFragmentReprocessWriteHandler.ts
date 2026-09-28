import { createAutomationConnectionStore, GMAIL_READONLY_SCOPE } from './automationConnectionStore.js'
import { fetchGmailSemanticRecordsByIds } from './gmailAutomation.js'
import { fragmentLimitReprocessTargetIds, reprocessVersion, type GmailFragmentReprocessDryRunConfig } from './gmailFragmentReprocessDryRunHandler.js'
import { refreshGoogleAccessToken } from './googleOAuthTokens.js'
import { createTransactionalWorkspaceSource } from './transactionalWorkspaceSource.js'
import { decryptSecret } from './tokenCrypto.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceWriteCommand } from './workspaceSource.js'
import { applyGmailSemanticBatch, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { stableIngestionHash } from '../src/ingestion.js'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { fragmentBindingShape, fragmentBusinessDeltaDigest, fragmentEvidenceShape, fragmentSafetyDigest } from '../src/fragmentReprocessSafety.js'
import type { GmailAutomationBinding } from './automationConnectionStore.js'
import type { GatewayWorkspace, WorkspaceWriteInput } from './workspaceSource.js'

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
  if (!selected.length) return { snapshot, selectedIds: [] as string[] }

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
  return { snapshot: boundedSnapshot, selectedIds }
}

export function fragmentSettlementWriteCommand(revision: number, selectedIds: string[], effectiveTime: string): WorkspaceWriteCommand {
  // A mixed APPLIED/NO_WRITE batch has no complete automatic compensation:
  // NO_WRITE settles debt through ledger rows without a semantic receipt.
  return {
    commandId: `gmail:fragment-reprocess-write:${revision}:${stableIngestionHash(selectedIds.join('|'))}`,
    operation: 'gmail_fragment_reprocess_settlement',
    payload: { sourceId: GMAIL_SOURCE_ID, selectedIds },
    provenance: { sourceId: GMAIL_SOURCE_ID, adapterVersion: 'fragment-reprocess-write-v1' },
    effectiveTime,
  }
}

export interface FragmentSettlementAuthorization {
  expectedProjectedSettledCount: 39
  bindingDigest: string
  targetSetDigest: string
  evidenceDigest: string
  settledSetDigest: string
  businessDeltaDigest: string
}

export interface FragmentSettlementDependencies {
  binding(): Promise<GmailAutomationBinding[]>
  read(binding: GmailAutomationBinding): Promise<GatewayWorkspace>
  evidence(binding: GmailAutomationBinding, targets: string[], snapshot: PJSDASSnapshot, now: Date): Promise<{
    records: GmailSemanticRecord[]; fetchedCount: number; unavailableCount: number
  }>
  commit(binding: GmailAutomationBinding, input: WorkspaceWriteInput): Promise<GatewayWorkspace>
  now(): Date
  maxRecords: number
}

/** Three complete attempts; only a revision CAS conflict permits another attempt. */
export async function executeBoundedFragmentSettlement(
  authorization: FragmentSettlementAuthorization, dependencies: FragmentSettlementDependencies,
) {
  let firstSettledSetDigest: string | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const bindings = await dependencies.binding()
    if (bindings.length !== 1) {
      throw new WorkspaceSourceError('BINDING_COUNT_CHANGED', 'Expected exactly one enabled Gmail binding.', false)
    }
    const binding = bindings[0]!
    if (binding.gmailIntakeConsentVersion !== 'uu06-v1'
      || !binding.grantedScopes.includes(GMAIL_READONLY_SCOPE)
      || await fragmentSafetyDigest(fragmentBindingShape(binding)) !== authorization.bindingDigest) {
      throw new WorkspaceSourceError('BINDING_CHANGED', 'Authorized Gmail binding or scope changed.', false)
    }
    const workspace = await dependencies.read(binding)
    const version = workspace.context.workspaceVersion
    const match = /^txn:(\d+)$/.exec(version ?? '')
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      throw new WorkspaceSourceError('WORKSPACE_VERSION_INVALID', 'Transactional workspace revision is required.', false)
    }
    const revision = Number(match[1])
    const targets = fragmentLimitReprocessTargetIds(workspace.snapshot)
    if (!targets.length || targets.length > dependencies.maxRecords
      || await fragmentSafetyDigest(targets) !== authorization.targetSetDigest) {
      throw new WorkspaceSourceError('TARGET_SET_CHANGED', 'Authorized fragment target set changed.', false)
    }
    const now = dependencies.now()
    const parsed = await dependencies.evidence(binding, targets, workspace.snapshot, now)
    const records = parsed.records.map(reprocessVersion)
    const recordIds = records.map(recordId).sort()
    if (parsed.fetchedCount !== targets.length || parsed.unavailableCount !== 0
      || recordIds.length !== targets.length || recordIds.some((id, index) => id !== targets[index])
      || await fragmentSafetyDigest(fragmentEvidenceShape(records)) !== authorization.evidenceDigest) {
      throw new WorkspaceSourceError('PARSER_SAFETY_CHANGED', 'Gmail evidence or parser safety changed.', false)
    }
    const plan = planFragmentReprocessWrite(workspace.snapshot, records, {
      checkedAt: now.toISOString(), workspaceVersion: version!, targetIds: targets,
    })
    const settledSetDigest = await fragmentSafetyDigest(plan.selectedIds)
    const businessDeltaDigest = await fragmentBusinessDeltaDigest(
      workspace.snapshot, plan.snapshot, now.toISOString())
    if (plan.selectedIds.length !== 39 || authorization.expectedProjectedSettledCount !== 39
      || settledSetDigest !== authorization.settledSetDigest
      || businessDeltaDigest !== authorization.businessDeltaDigest
      || (firstSettledSetDigest !== undefined && settledSetDigest !== firstSettledSetDigest)) {
      throw new WorkspaceSourceError('SETTLEMENT_PROJECTION_CHANGED', 'Authorized settlement projection changed.', false)
    }
    firstSettledSetDigest = settledSetDigest
    try {
      const written = await dependencies.commit(binding, {
        snapshot: plan.snapshot,
        expectedWorkspaceVersion: version,
        updatedByDevice: 'gmail-fragment-reprocess-write',
        command: fragmentSettlementWriteCommand(revision, plan.selectedIds, now.toISOString()),
      })
      return {
        status: 'committed', selectedCount: plan.selectedIds.length, attempts: attempt,
        workspaceRevisionBefore: revision, workspaceVersionAfter: written.context.workspaceVersion,
      }
    } catch (caught) {
      if (!(caught instanceof WorkspaceSourceError) || caught.code !== 'WORKSPACE_CONFLICT' || attempt === 3) throw caught
    }
  }
  throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Bounded CAS attempts exhausted.', true)
}

/** Explicit one-shot authorized request. No scheduler or dry-run route calls this handler. */
export function createGmailFragmentReprocessWriteHandler(config: GmailFragmentReprocessDryRunConfig) {
  return async function handle(request: Request) {
    if (request.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED' })
    if (new URL(request.url).searchParams.get('write') !== '1') {
      return json(409, { code: 'EXPLICIT_WRITE_REQUIRED' })
    }
    const workerToken = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1]?.trim()
    if (!workerToken) return json(401, { code: 'AUTOMATION_AUTH_REQUIRED' })
    const body = await request.json().catch(() => undefined) as Partial<FragmentSettlementAuthorization> | undefined
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    if (body?.expectedProjectedSettledCount !== 39
      || !digest(body.bindingDigest) || !digest(body.targetSetDigest)
      || !digest(body.evidenceDigest) || !digest(body.settledSetDigest)
      || !digest(body.businessDeltaDigest)) {
      return json(400, { code: 'EXACT_PROJECTION_REQUIRED' })
    }

    try {
      const store = createAutomationConnectionStore({
        supabaseUrl: config.supabaseUrl,
        supabasePublishableKey: config.supabasePublishableKey,
        workerToken,
        fetchImpl: config.fetchImpl,
      })
      const result = await executeBoundedFragmentSettlement(body as FragmentSettlementAuthorization, {
        binding: () => store.listEnabledGmailBindings(),
        read: (binding) => createTransactionalWorkspaceSource({
          userId: binding.userId, supabaseUrl: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey, principalKind: 'automation',
          sourceId: 'gmail-fragment-reprocess-write', timezone: 'Asia/Shanghai',
          fetchImpl: config.fetchImpl, now: config.now,
        }).read(),
        evidence: async (binding, targets, snapshot, now) => {
          const refreshToken = await decryptSecret(binding.refreshTokenCiphertext, config.tokenEncryptionKey)
          const accessToken = await refreshGoogleAccessToken(refreshToken, {
            clientId: config.googleClientId, clientSecret: config.googleClientSecret, fetchImpl: config.fetchImpl,
          })
          return fetchGmailSemanticRecordsByIds({
            accessToken, messageIds: targets, opportunities: snapshot.data.opportunities,
            fetchImpl: config.fetchImpl, now,
          })
        },
        commit: (binding, input) => requireWritableWorkspaceSource(createTransactionalWorkspaceSource({
          userId: binding.userId, supabaseUrl: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey, principalKind: 'automation',
          sourceId: 'gmail-fragment-reprocess-write', timezone: 'Asia/Shanghai',
          fetchImpl: config.fetchImpl, now: config.now,
        })).write(input),
        now: () => config.now?.() ?? new Date(),
        maxRecords: Math.max(1, Math.min(config.maxRecords ?? 100, 100)),
      })
      return json(200, result)
    } catch (caught) {
      const code = caught instanceof WorkspaceSourceError ? caught.code : 'AUTOMATION_FAILED'
      return json(code === 'AUTOMATION_AUTH_REQUIRED' ? 401
        : caught instanceof WorkspaceSourceError && !caught.retryable ? 409
          : code === 'WORKSPACE_CONFLICT' ? 409 : 500, { code })
    }
  }
}
