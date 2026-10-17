import { describe, expect, it, vi } from 'vitest'
import { invokeReadTool } from '../gateway/readTools.js'
import { invokeAddOpportunities } from '../gateway/addOpportunities.js'
import { invokeTrustedIngestion } from '../gateway/ingestSources.js'
import { getApplicationPortfolio } from '../src/ai/applicationPortfolioRead.js'
import { getDiscoveryContext, getTodayPlan, listOpportunities } from '../src/ai/readLayer.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { applyDiscoveryProfileCommand } from '../src/discoveryProfileCommand.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { unknownDeadlineWorkspace, UNKNOWN_DEADLINE_NOW } from './fixtures/unknownDeadlineWorkspace.js'

const decoded = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content.find(item => item.type === 'text')!.text!)
describe('scoring retirement contracts and factual compatibility', () => {
  it.each(['get_decision_rules', 'get_opportunity_assessment', 'explain_priority'] as const)('retires %s without reading historical ratings', async name => {
    const read = vi.fn(async () => { throw new Error('Unexpected read') })
    const result = await invokeReadTool({ read }, name, {})
    expect(decoded(result)).toMatchObject({ code: 'SCORING_RETIRED', retryable: false })
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects stale score-bearing additive and ingestion input without any write', async () => {
    const read = vi.fn(async () => { throw new Error('Unexpected read') })
    const added = await invokeAddOpportunities({ read }, { opportunities: [{ company: 'Synthetic', fitScore: 80 }] })
    const ingested = await invokeTrustedIngestion({ read }, 'ingest_discovery_run', { observations: [{ opportunityValue: 80 }] })
    for (const result of [added, ingested]) expect(decoded(result)).toMatchObject({ code: 'SCORING_RETIRED' })
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps withdrawn application deadlines unknown in both opportunity and quota reads', () => {
    const snapshot = unknownDeadlineWorkspace(2, true)
    snapshot.data.applicationGroups = [{ id: 'quota', company: 'Synthetic', remaining: 1, total: 2, used: 1 }]
    for (const opportunity of snapshot.data.opportunities) opportunity.applicationGroupId = 'quota'
    const original = structuredClone(snapshot)
    const context = { now: UNKNOWN_DEADLINE_NOW, timezone: 'Asia/Shanghai' }
    const list = listOpportunities(snapshot, {}, context)
    const quota = getApplicationPortfolio(snapshot, { groupId: 'quota' }, context)
    expect(list.opportunities.map(item => item.opportunityId)).toEqual(['real-deadline', 'unknown-0', 'unknown-1'])
    for (const item of list.opportunities.slice(1)) expect(item.applicationDeadline).toBeUndefined()
    expect(quota.decisions[0].candidates.map(item => item.opportunityId)).toEqual(['real-deadline', 'unknown-0', 'unknown-1'])
    for (const item of quota.decisions[0].candidates.slice(1)) expect(item).toMatchObject({ deadlineExpired: false, deadlineState: 'unknown' })
    expect(snapshot).toEqual(original)
    expect(upgradeSnapshotToLatest(snapshot).data.opportunities.map(item => item.fitScore)).toEqual(original.data.opportunities.map(item => item.fitScore))
  })
  it('keeps fixed interviews separate from application deadlines and inactive jobs after active jobs', () => {
    const snapshot = unknownDeadlineWorkspace(1, true)
    const old = snapshot.data.opportunities[0]
    snapshot.data.opportunities.push({ ...old, id: 'closed', processStage: 'closed', detail: undefined, deadline: '2026-01-01' })
    snapshot.data.scheduleNodes!.push({ id: 'interview', occurrenceId: 'interview', version: 1, opportunityId: old.id,
      kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard', temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-02T16:00:00Z', endAt: '2026-10-02T17:00:00Z', resolutionBasis: 'source_explicit' },
      relatedActionIds: [], relatedPrepIds: [], evidenceRefs: ['synthetic'], sourceVersionRefs: [], createdAt: UNKNOWN_DEADLINE_NOW.toISOString(), updatedAt: UNKNOWN_DEADLINE_NOW.toISOString() })
    const result = listOpportunities(snapshot, {}, { now: UNKNOWN_DEADLINE_NOW, timezone: 'Asia/Shanghai' })
    expect(result.opportunities.map(item => item.opportunityId)).toEqual(['real-deadline', 'unknown-0', 'closed'])
    expect(result.opportunities[1].applicationDeadline).toBeUndefined()
  })
  it('uses local-day manual capacity and remaining time without legacy recurring defaults', () => {
    const snapshot = unknownDeadlineWorkspace(1)
    snapshot.data.timePlanning = { version: 1, defaultDailyMinutes: 999, dateOverrides: { '2026-10-03': 0 }, updatedAt: UNKNOWN_DEADLINE_NOW.toISOString() }
    const now = new Date('2026-10-02T16:30:00Z')
    const china = getTodayPlan(snapshot, {}, { now, timezone: 'Asia/Shanghai' })
    expect(china).toMatchObject({ date: '2026-10-03', availableMinutes: 0 })
    const california = getTodayPlan(snapshot, {}, { now, timezone: 'America/Los_Angeles' })
    expect(california).toMatchObject({ date: '2026-10-02', availableMinutes: 870 })
    expect(california.startableActions.every(item => !('priority' in item))).toBe(true)
  })
  it('preserves historical profile thresholds while facts remain editable and active reads exclude ratings', () => {
    const snapshot = unknownDeadlineWorkspace(1)
    snapshot.data.discoveryProfile = { ...createDefaultDiscoveryProfile(), targetRoleQueries: ['Research'], minimumFitScore: 99, minimumOpportunityValue: 98 }
    snapshot.data.discoveryProfile.notes = 'Original historical note'
    const updated = applyDiscoveryProfileCommand(snapshot, { targetRoleQueries: ['Research'], preferredLocations: [], mustHave: [], mustNotHave: [], searchGoal: 'An explicit current search' })
    expect(updated.snapshot.data.discoveryProfile).toMatchObject({ minimumFitScore: 99, minimumOpportunityValue: 98, notes: 'Original historical note', searchGoal: 'An explicit current search' })
    const read = getDiscoveryContext(updated.snapshot)
    expect(read).not.toHaveProperty('decisionWeights')
    expect(read.profile).not.toHaveProperty('minimumFitScore')
    expect(read.profile).not.toHaveProperty('minimumOpportunityValue')
  })
})
