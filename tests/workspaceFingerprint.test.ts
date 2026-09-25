import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot.js'
import { DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { canonicalWorkspaceJson, equivalentReadProjection, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from '../src/cloud/workspaceFingerprint.js'

function snapshot(exportedAt: string, company?: string) {
  return createSnapshot({
    opportunities: company ? [{
      id: 'role-1', company, role: 'Product', currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core', early: false,
      opportunityValue: 80, fitScore: 60, importedAt: '2026-09-11T00:00:00.000Z',
    }] : [],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: { ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights } },
    timeline: [], changeSets: [],
  }, exportedAt)
}

function inboxSnapshot(exportedAt: string) {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: { ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights } },
    discoveryInbox: [{
      id: 'inbox:role-1',
      candidateOpportunityId: 'role-1',
      company: 'Example',
      role: 'AI Product Manager',
      roleType: 'core',
      sourceUrl: 'https://careers.example.com/role-1',
      sourceTitle: 'Example AI Product Manager',
      rationale: 'Matches the explicit AI product target.',
      opportunityValue: 86,
      fitScore: 78,
      fitConfidence: 'medium',
      opportunityValueConfidence: 'medium',
      status: 'later',
      discoveredAt: '2026-09-11T01:00:00.000Z',
      createdAt: '2026-09-11T01:05:00.000Z',
      updatedAt: '2026-09-11T01:05:00.000Z',
    }],
    timeline: [], changeSets: [],
  }, exportedAt)
}

describe('cloud workspace fingerprint', () => {
  it('ignores snapshot export time', async () => {
    const a = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    const b = snapshot('2026-09-12T00:00:00.000Z', 'Example')
    expect(canonicalWorkspaceJson(a)).toBe(canonicalWorkspaceJson(b))
    expect(await fingerprintWorkspace(a)).toBe(await fingerprintWorkspace(b))
  })

  it('changes when workspace data changes', async () => {
    expect(await fingerprintWorkspace(snapshot('2026-09-11T00:00:00.000Z', 'A')))
      .not.toBe(await fingerprintWorkspace(snapshot('2026-09-11T00:00:00.000Z', 'B')))
  })

  it('recognizes an untouched empty local workspace', () => {
    expect(workspaceIsEffectivelyEmpty(snapshot('2026-09-11T00:00:00.000Z'))).toBe(true)
    expect(workspaceIsEffectivelyEmpty(snapshot('2026-09-11T00:00:00.000Z', 'A'))).toBe(false)
  })

  it('treats a configured Discovery Profile as meaningful local data', () => {
    const empty = snapshot('2026-09-11T00:00:00.000Z')
    empty.data.discoveryProfile = createDefaultDiscoveryProfile('2026-09-11T01:00:00.000Z')
    expect(workspaceIsEffectivelyEmpty(empty)).toBe(true)

    const configured = snapshot('2026-09-11T00:00:00.000Z')
    configured.data.discoveryProfile = {
      ...createDefaultDiscoveryProfile('2026-09-11T01:00:00.000Z'),
      targetRoleQueries: ['AI 产品经理'],
    }
    expect(workspaceIsEffectivelyEmpty(configured)).toBe(false)
  })

  it('treats Discovery Inbox as durable workspace data included in the fingerprint', async () => {
    const empty = snapshot('2026-09-11T00:00:00.000Z')
    const inbox = inboxSnapshot('2026-09-11T00:00:00.000Z')
    expect(workspaceIsEffectivelyEmpty(inbox)).toBe(false)
    expect(await fingerprintWorkspace(inbox)).not.toBe(await fingerprintWorkspace(empty))
  })

  it('treats newer server Gmail audit as read-only while preserving business comparison', () => {
    const local = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    const remote = structuredClone(local)
    remote.data.timeline = [{
      id: 'timeline:ingestion:ignored-1', kind: 'ingestion_recorded', category: 'data', source: 'gmail',
      occurredAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:00.000Z', title: 'Ignored',
      ingestion: { version: 1, sourceKind: 'gmail', sourceId: 'gmail', sourceRecordId: 'msg-1', runId: 'run-1',
        fingerprint: 'msg-fp', recordType: 'recruiting_message', outcome: 'ignored',
        receivedAt: '2026-09-25T00:00:00.000Z', accountedAt: '2026-09-25T00:00:00.000Z' },
    } as any, {
      id: 'timeline:ingestion-run:run-1', kind: 'ingestion_run_completed', category: 'data', source: 'gmail',
      occurredAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:00.000Z', title: 'Run',
      ingestionRun: { version: 1, sourceKind: 'gmail', sourceId: 'gmail', runId: 'run-1',
        startedAt: '2026-09-25T00:00:00.000Z', completedAt: '2026-09-25T00:00:00.000Z',
        receivedCount: 1, accountedCount: 1, outcomes: { ignored: 1 } },
    } as any]
    expect(equivalentReadProjection(local, remote)).toBe(true)
    local.data.opportunities[0]!.company = 'Edited locally'
    expect(equivalentReadProjection(local, remote)).toBe(false)
    local.data.opportunities[0]!.company = 'Example'
    remote.data.opportunities[0]!.company = 'Changed by server'
    expect(equivalentReadProjection(local, remote)).toBe(false)
  })

  it('does not normalize away an unsynced legacy deadline edit', () => {
    const base = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    base.data.opportunities[0]!.deadline = '2026-10-01'
    const remote = createSnapshot(base.data)
    const local = structuredClone(remote)
    local.data.opportunities[0]!.deadline = '2026-10-02'
    expect(equivalentReadProjection(local, remote)).toBe(false)
  })

  it('fails closed for local-only ingestion evidence and local timeline edits', () => {
    const remote = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    const local = structuredClone(remote)
    local.data.timeline = [{ id: 'local-audit', kind: 'ingestion_recorded', ingestion: { outcome: 'ignored' } } as any]
    expect(equivalentReadProjection(local, remote)).toBe(false)
    local.data.timeline = [{ id: 'manual-note', kind: 'history_imported', source: 'user_action' } as any]
    expect(equivalentReadProjection(local, remote)).toBe(false)
  })

  it('matches only equivalent hydrated read projections', () => {
    const remote = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    delete remote.data.decisionRules
    const local = snapshot('2026-09-11T00:00:00.000Z', 'Example')
    local.data.timeline = [{ id: 'derived-1', kind: 'baseline_backfill', source: 'system' } as any]
    expect(equivalentReadProjection(local, remote)).toBe(true)
    local.data.opportunities[0]!.company = 'Changed locally'
    expect(equivalentReadProjection(local, remote)).toBe(false)
  })
})
