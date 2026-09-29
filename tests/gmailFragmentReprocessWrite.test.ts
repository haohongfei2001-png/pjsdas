import { describe, expect, it } from 'vitest'
import { createGmailFragmentReprocessWriteHandler, executeBoundedFragmentSettlement, fragmentSettlementWriteCommand, planFragmentReprocessWrite } from '../gateway/gmailFragmentReprocessWriteHandler.js'
import { fragmentLimitReprocessTargetIds } from '../gateway/gmailFragmentReprocessDryRunHandler.js'
import { createIngestionLedgerTimeline } from '../src/ingestion.js'
import { createSnapshot, upgradeSnapshotToLatest, validateSnapshot } from '../src/snapshot.js'
import type { GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import type { TimelineRecord } from '../src/model.js'
import { fragmentBindingShape, fragmentBusinessDeltaDigest, fragmentEvidenceShape, fragmentSafetyDigest } from '../src/fragmentReprocessSafety.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'
import type { FragmentSettlementDependencies } from '../gateway/gmailFragmentReprocessWriteHandler.js'
import { denseDecision } from './fixtures/denseDecisionWorkspace.js'

const checkedAt = '2026-09-28T00:00:00.000Z'

function legacyTarget(id: string) {
  const ingestion = createIngestionLedgerTimeline({
    sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: id,
    runId: `legacy:${id}`, recordType: 'recruiting_message', outcome: 'unresolved',
    fingerprint: `fp:${id}`, receivedAt: '2026-09-25T00:00:00.000Z',
    accountedAt: '2026-09-25T00:00:00.000Z',
    reason: 'Message exceeds the 20-fragment interpretation limit.',
  })
  const resolution: TimelineRecord = {
    id: `resolution:${id}`, kind: 'ingestion_resolution_recorded', category: 'data', source: 'system',
    occurredAt: '2026-09-27T00:00:00.000Z', recordedAt: '2026-09-27T00:00:00.000Z',
    title: 'Legacy active debt',
    ingestionResolution: {
      version: 1, sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: id,
      targetIngestionTimelineId: ingestion.id, targetFingerprint: ingestion.ingestion!.fingerprint,
      outcome: 'active_unresolved', reason: 'unlinked_unresolved', evidenceRefs: [ingestion.id],
      reconciledAt: '2026-09-27T00:00:00.000Z',
    },
  }
  return [ingestion, resolution]
}

function record(id: string, gaps: string[] = []): GmailSemanticRecord {
  return {
    receivedAt: '2026-09-25T00:00:00.000Z', gaps,
    observation: {
      contractVersion: 1, inputId: `gmail:${id}:fragment-reprocess-v2`,
      source: {
        kind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: id,
        sourceVersion: 'fragment-reprocess-v2', observedAt: checkedAt,
        assertedAt: checkedAt, timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion', candidates: [],
    },
  }
}

describe('Gmail fragment settlement write', () => {
  it('commits only fully parsed, conclusively settled targets and preserves historical ledger rows', () => {
    const original = createSnapshot({
      opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
      timeline: [...legacyTarget('complete'), ...legacyTarget('gap'), ...legacyTarget('action'), ...legacyTarget('decision')],
    }, '2026-09-27T00:00:00.000Z')
    const originalIds = original.data.timeline.map((item) => item.id)
    const targets = fragmentLimitReprocessTargetIds(original)
    expect(targets).toEqual(['action', 'complete', 'decision', 'gap'])
    const action = record('action')
    action.observation.candidates = [{
      id: 'manual-action', kind: 'manual_action', title: 'Follow up with recruiter',
      objectConfidence: 'high', eventConfidence: 'high',
      evidenceRefs: ['fragment-reprocess'], sourceVersionRefs: ['action:fragment-reprocess-v2'],
    }]
    const decision = record('decision')
    decision.observation.candidates = [{
      id: 'uncertain-action', kind: 'manual_action', title: 'Unclear recruiter request',
      objectConfidence: 'low', eventConfidence: 'low',
      evidenceRefs: ['fragment-reprocess'], sourceVersionRefs: ['decision:fragment-reprocess-v2'],
    }]
    const plan = planFragmentReprocessWrite(original, [record('complete'), record('gap', ['parser gap']), action, decision], {
      checkedAt, workspaceVersion: 'txn:770', targetIds: targets,
    })
    expect(plan.selectedIds).toEqual(['action', 'complete'])
    expect(plan.snapshot.data.actions).toHaveLength(1)
    expect(plan.snapshot.data.decisionRequests).toHaveLength(0)
    const command = fragmentSettlementWriteCommand(770, plan.selectedIds, checkedAt)
    expect(command).not.toHaveProperty('compensation')
    expect(command.payload).toEqual({ sourceId: 'gmail:primary', selectedIds: ['action', 'complete'] })
    expect(plan.snapshot.data.timeline.map((item) => item.id)).toEqual(expect.arrayContaining(originalIds))
    const persisted = upgradeSnapshotToLatest(createSnapshot(plan.snapshot.data, plan.snapshot.exportedAt))
    expect(fragmentLimitReprocessTargetIds(persisted)).toEqual(['decision', 'gap'])
    expect(persisted.data.timeline.some((item) => item.ingestion?.sourceRecordId === 'gap'
      && item.ingestion.runId.startsWith('gmail:fragment-reprocess-write:'))).toBe(false)
    validateSnapshot(persisted)
  })

  it('requires an explicit write route and exact projection before external access', async () => {
    const handler = createGmailFragmentReprocessWriteHandler({
      supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'publishable',
      supabaseServiceRoleKey: 'service-role', tokenEncryptionKey: 'token-key',
      googleClientId: 'client', googleClientSecret: 'secret',
      fetchImpl: async () => { throw new Error('External access must not occur.') },
    })
    const url = 'https://example.invalid/api/automation-gmail?__pjsdas_gmail_route=fragment_reprocess_write'
    const headers = { authorization: 'Bearer worker', 'content-type': 'application/json' }
    expect((await handler(new Request(url, { method: 'POST', headers, body: '{}' }))).status).toBe(409)
    expect((await handler(new Request(`${url}&write=1`, { method: 'POST', headers, body: '{}' }))).status).toBe(400)
    expect((await handler(new Request(`${url}&write=1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 770, expectedProjectedSettledCount: 39 }),
    }))).status).toBe(401)
  })

  async function boundedFixture(options: { conflicts: number; count?: number; change?: 'target' | 'projection' | 'parser' | 'binding' | 'delta' }) {
    const count = options.count ?? 38
    const ids = Array.from({ length: count }, (_, index) => `fragment-${String(index).padStart(2, '0')}`)
    const baseline = createSnapshot({
      opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
      scheduleNodes: options.change === 'delta' ? [{
        id: 'interview-v1', occurrenceId: 'interview-1', version: 1, kind: 'interview', state: 'scheduled',
        temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai',
          startAt: '2026-09-30T02:00:00.000Z', endAt: '2026-09-30T03:00:00.000Z', resolutionBasis: 'source_explicit' },
        constraintKind: 'employer_hard', evidenceRefs: ['prior'], sourceVersionRefs: [],
        relatedActionIds: [], relatedPrepIds: [], createdAt: checkedAt, updatedAt: checkedAt,
      }] as const : [],
      timeline: ids.flatMap(legacyTarget),
    }, '2026-09-27T00:00:00.000Z')
    const binding = {
      userId: 'owner', googleSubject: 'google-owner', refreshTokenCiphertext: 'ciphertext',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      gmailIntakeConsentVersion: 'uu06-v1' as const, gmailPendingMessageIds: [],
    }
    const baselineRecords = ids.map((id) => record(id))
    if (options.change === 'delta') baselineRecords[0]!.observation.candidates = [{
      id: 'complete-interview', kind: 'occurrence_completed', target: { occurrenceId: 'interview-1' },
      objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['gmail'],
      sourceVersionRefs: [`${ids[0]}:fragment-reprocess-v2`],
    }]
    const baselinePlan = planFragmentReprocessWrite(baseline, baselineRecords, {
      checkedAt, workspaceVersion: 'txn:800', targetIds: ids,
    })
    const selected = baselinePlan.selectedIds
    expect(selected).toEqual(ids)
    const authorization = {
      expectedProjectedSettledCount: count,
      bindingDigest: await fragmentSafetyDigest(fragmentBindingShape(binding)),
      targetSetDigest: await fragmentSafetyDigest(ids),
      evidenceDigest: await fragmentSafetyDigest(fragmentEvidenceShape(baselineRecords)),
      settledSetDigest: await fragmentSafetyDigest(selected),
      businessDeltaDigest: await fragmentBusinessDeltaDigest(baseline, baselinePlan.snapshot, checkedAt),
    }
    const calls = { reads: 0, evidence: 0, commits: 0, successfulWrites: 0, versions: [] as string[] }
    const dependencies: FragmentSettlementDependencies = {
      binding: async () => options.change === 'binding' && calls.reads > 0
        ? [{ ...binding, googleSubject: 'other-account' }] : [binding],
      read: async () => {
        calls.reads += 1
        const snapshot = structuredClone(baseline)
        if (options.change === 'target' && calls.reads > 1) snapshot.data.timeline.push(...legacyTarget('new-target'))
        if (options.change === 'delta' && calls.reads > 1) {
          const first = snapshot.data.scheduleNodes![0]!
          first.state = 'superseded'
          first.supersededByNodeId = 'interview-v2'
          snapshot.data.scheduleNodes!.push({ ...structuredClone(first), id: 'interview-v2', version: 2,
            state: 'scheduled', supersedesNodeId: first.id, supersededByNodeId: undefined,
            temporal: { ...first.temporal, startAt: '2026-10-01T02:00:00.000Z', endAt: '2026-10-01T03:00:00.000Z' },
          })
          const changedPlan = planFragmentReprocessWrite(snapshot, baselineRecords, {
            checkedAt, workspaceVersion: 'txn:801', targetIds: ids,
          })
          expect(changedPlan.selectedIds).toEqual(ids)
          expect(await fragmentBusinessDeltaDigest(snapshot, changedPlan.snapshot, checkedAt))
            .not.toBe(authorization.businessDeltaDigest)
        }
        if (options.change === 'projection' && calls.reads > 1) {
          const historical = denseDecision(999)
          historical.payloadBinding.source.sourceId = 'gmail:primary'
          historical.payloadBinding.source.sourceRecordId = ids[0]!
          snapshot.data.decisionRequests = [historical]
        }
        return { snapshot, context: {
          now: new Date(checkedAt), timezone: 'Asia/Shanghai',
          workspaceVersion: `txn:${799 + calls.reads}`,
        } }
      },
      evidence: async (_binding, targets) => {
        calls.evidence += 1
        const records = targets.map((id) => options.change === 'delta'
          ? structuredClone(baselineRecords.find((item) => item.observation.source.sourceRecordId === id)!) : record(id))
        if (options.change === 'parser' && calls.evidence > 1) records[0]!.gaps.push('new parser gap')
        return { records, fetchedCount: records.length, unavailableCount: 0 }
      },
      commit: async (_binding, input) => {
        calls.commits += 1
        calls.versions.push(input.expectedWorkspaceVersion ?? '')
        if (calls.commits <= options.conflicts) {
          throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Concurrent automation advanced the workspace.', true)
        }
        calls.successfulWrites += 1
        return { snapshot: input.snapshot, context: {
          now: new Date(checkedAt), timezone: 'Asia/Shanghai', workspaceVersion: 'txn:900',
        } }
      },
      now: () => new Date(checkedAt), maxRecords: 100,
    }
    return { authorization, dependencies, calls }
  }

  it.each([1, 2])('re-reads and reprojects after %i revision conflicts, then commits once', async (conflicts) => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts })
    const result = await executeBoundedFragmentSettlement(authorization, dependencies)
    expect(result.attempts).toBe(conflicts + 1)
    expect(result.selectedCount).toBe(38)
    expect(calls).toMatchObject({ reads: conflicts + 1, evidence: conflicts + 1,
      commits: conflicts + 1, successfulWrites: 1 })
    expect(calls.versions).toEqual(['txn:800', 'txn:801', 'txn:802'].slice(0, conflicts + 1))
  })

  it.each([
    ['target', 'TARGET_SET_CHANGED'],
    ['projection', 'SETTLEMENT_PROJECTION_CHANGED'],
    ['parser', 'PARSER_SAFETY_CHANGED'],
    ['binding', 'BINDING_CHANGED'],
    ['delta', 'SETTLEMENT_PROJECTION_CHANGED'],
  ] as const)('aborts after revision churn when %s changes', async (change, code) => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 1, change })
    await expect(executeBoundedFragmentSettlement(authorization, dependencies))
      .rejects.toMatchObject({ code })
    expect(calls.commits).toBe(1)
    expect(calls.successfulWrites).toBe(0)
  })

  it('stops after three CAS conflicts with zero successful writes', async () => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 3 })
    await expect(executeBoundedFragmentSettlement(authorization, dependencies))
      .rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(calls).toMatchObject({ reads: 3, evidence: 3, commits: 3, successfulWrites: 0 })
    expect(calls.versions).toEqual(['txn:800', 'txn:801', 'txn:802'])
  })

  it('accepts the exact 38-settlement authorization baseline', async () => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 0 })
    const result = await executeBoundedFragmentSettlement(authorization, dependencies)
    expect(result).toMatchObject({ status: 'committed', selectedCount: 38, attempts: 1 })
    expect(calls.successfulWrites).toBe(1)
  })

  it.each([37, 39])('rejects actual %i settlements against exact authorization count 38', async (count) => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 0, count })
    // All five digests match the actual plan: count equality is independently mandatory.
    authorization.expectedProjectedSettledCount = 38
    await expect(executeBoundedFragmentSettlement(authorization, dependencies))
      .rejects.toMatchObject({ code: 'SETTLEMENT_PROJECTION_CHANGED' })
    expect(calls.commits).toBe(0)
  })

  it('rejects the same count when the authorized settled-set digest differs', async () => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 0 })
    authorization.settledSetDigest = await fragmentSafetyDigest(['different-set-of-38'])
    await expect(executeBoundedFragmentSettlement(authorization, dependencies))
      .rejects.toMatchObject({ code: 'SETTLEMENT_PROJECTION_CHANGED' })
    expect(calls.commits).toBe(0)
  })

  it.each(['count-increase', 'settled-set-swap'] as const)('rejects retry %s while Gmail evidence and target set remain identical', async (change) => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 1, count: 39 })
    const read = dependencies.read
    const baselineWorkspace = await read((await dependencies.binding())[0]!)
    calls.reads = 0
    const ids = fragmentLimitReprocessTargetIds(baselineWorkspace.snapshot)
    const addOpenDecision = (snapshot: typeof baselineWorkspace.snapshot, id: string) => {
      const next = structuredClone(snapshot)
      const historical = denseDecision(Number(id.slice(-2)))
      historical.id = `historical:${id}`
      historical.payloadBinding.source.sourceId = 'gmail:primary'
      historical.payloadBinding.source.sourceRecordId = id
      next.data.decisionRequests = [...(next.data.decisionRequests ?? []), historical]
      return next
    }
    const baselineSnapshot = addOpenDecision(baselineWorkspace.snapshot, ids[38]!)
    const baselinePlan = planFragmentReprocessWrite(baselineSnapshot, ids.map((id) => record(id)), {
      checkedAt, workspaceVersion: 'txn:800', targetIds: ids,
    })
    expect(baselinePlan.selectedIds).toHaveLength(38)
    authorization.expectedProjectedSettledCount = 38
    authorization.settledSetDigest = await fragmentSafetyDigest(baselinePlan.selectedIds)
    authorization.businessDeltaDigest = await fragmentBusinessDeltaDigest(baselineSnapshot, baselinePlan.snapshot, checkedAt)
    dependencies.read = async (binding) => {
      const workspace = await read(binding)
      if (calls.reads === 1) workspace.snapshot = structuredClone(baselineSnapshot)
      else if (change === 'settled-set-swap') workspace.snapshot = addOpenDecision(workspace.snapshot, ids[0]!)
      return workspace
    }
    await expect(executeBoundedFragmentSettlement(authorization, dependencies))
      .rejects.toMatchObject({ code: 'SETTLEMENT_PROJECTION_CHANGED' })
    expect(calls).toMatchObject({ reads: 2, evidence: 2, commits: 1, successfulWrites: 0 })
  })

  it.each([0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])('rejects unbounded authorization count %s before reads', async (count) => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 0 })
    authorization.expectedProjectedSettledCount = count
    await expect(executeBoundedFragmentSettlement(authorization, dependencies))
      .rejects.toMatchObject({ code: 'EXACT_PROJECTION_REQUIRED' })
    expect(calls.reads).toBe(0)
    expect(calls.commits).toBe(0)
  })

  it('rejects an authorization count exceeding the configured target bound', async () => {
    const { authorization, dependencies, calls } = await boundedFixture({ conflicts: 0 })
    dependencies.maxRecords = 37
    await expect(executeBoundedFragmentSettlement(authorization, dependencies))
      .rejects.toMatchObject({ code: 'EXACT_PROJECTION_REQUIRED' })
    expect(calls.reads).toBe(0)
  })
})
