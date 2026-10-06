import { getApplicationPortfolio } from '../src/ai/applicationPortfolioRead.js'
import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { readOpportunityManagement, applyOpportunityManagement, opportunityManagementFingerprint } from '../src/opportunityManagement.js'
import { getDiscoveryProfileManagementRead, applyDiscoveryProfileManagement, discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { readBusinessManagement, applyBusinessManagement } from '../src/businessManagement.js'
import { listOpportunities, getTodayPlan } from '../src/ai/readLayer.js'
import { buildOpportunityDecisionList } from '../src/opportunityDecisionRead.js'
import type { Opportunity } from '../src/model.js'
const at = '2026-10-06T00:00:00Z'
const opportunity = (id: string): Opportunity => ({ id, company: 'Synthetic', role: id, processStage: 'not_applied', currentStageLabel: '待投', roleType: 'core', early: false,
  fitScore: 91, opportunityValue: 89, assessmentStatus: 'assessed', importedAt: at,
  detail: { backgroundTag: 'Source fact', assessment: { version: 1, mode: 'component', assessedAt: at, fit: { skills: { score: 91, confidence: 'high', rationale: 'Historical' } }, opportunityValue: { roleGrowth: { score: 89, confidence: 'high', rationale: 'Historical' } } },
    discovery: { sourceUrl: 'https://example.test/job', sourceTitle: 'Official source', discoveredAt: at, fitConfidence: 'high', opportunityValueConfidence: 'medium' } } })
function fixture() { return createSnapshot({ opportunities: [opportunity('job')], processes: [], processEvents: [], prep: [], applicationGroups: [],
  actions: [{ id: 'manual', kind: 'manual', title: 'Existing task', estimatedMinutes: 20, leverage: 81, delayCost: 77, status: 'todo', createdAt: at, updatedAt: at }],
  discoveryProfile: { ...createDefaultDiscoveryProfile(at), targetRoleQueries: ['Research'], minimumFitScore: 96, minimumOpportunityValue: 97 } }, at) }

describe('score-free scoped reads preserve raw editing authority', () => {
  it('projects opportunity ratings away while retaining a usable raw fingerprint and historical data', async () => {
    const snapshot = fixture(), before = structuredClone(snapshot)
    const read = await readOpportunityManagement(snapshot, 'job')
    expect(read.opportunity).not.toHaveProperty('fitScore')
    expect(read.opportunity).not.toHaveProperty('opportunityValue')
    expect(read.opportunity).not.toHaveProperty('assessmentStatus')
    expect(read.opportunity.detail).not.toHaveProperty('assessment')
    expect(read.opportunity.detail?.discovery).not.toHaveProperty('fitConfidence')
    expect(read.opportunity.detail?.discovery?.sourceTitle).toBe('Official source')
    expect(read.profileFingerprint).toBe(await opportunityManagementFingerprint(before.data.opportunities[0]))
    const changed = await applyOpportunityManagement(snapshot, { operations: [{ kind: 'update_opportunity_profile', id: 'job', expectedFingerprint: read.profileFingerprint, patch: { detail: { backgroundTag: 'Explicit update' } } }] }, 'read-edit-opportunity')
    expect(changed.snapshot.data.opportunities[0].detail?.assessment).toEqual(before.data.opportunities[0].detail?.assessment)
    expect(changed.snapshot.data.opportunities[0].fitScore).toBe(91)
    expect(snapshot).toEqual(before)
  })
  it('projects retired thresholds out of raw/effective preference reads while exact edit fingerprints still work', async () => {
    const snapshot = fixture(), before = structuredClone(snapshot)
    const read = await getDiscoveryProfileManagementRead(snapshot)
    for (const row of [read.raw, read.effective]) {
      expect(row).not.toHaveProperty('minimumFitScore')
      expect(row).not.toHaveProperty('minimumOpportunityValue')
    }
    expect(read.fingerprint).toBe(await discoveryProfileManagementFingerprint(before.data.discoveryProfile))
    const changed = await applyDiscoveryProfileManagement(snapshot, { kind: 'patch_discovery_profile', expectedFingerprint: read.fingerprint, patch: { notes: 'Explicit new preference' } }, 'read-edit-profile')
    expect(changed.snapshot.data.discoveryProfile).toMatchObject({ minimumFitScore: 96, minimumOpportunityValue: 97 })
    expect(snapshot).toEqual(before)
  })
  it('projects manual-action ratings away and preserves them during a factual title edit', () => {
    const snapshot = fixture(), before = structuredClone(snapshot)
    const read = readBusinessManagement(snapshot, { type: 'action' })
    expect(read.items[0]).not.toHaveProperty('leverage')
    expect(read.items[0]).not.toHaveProperty('delayCost')
    const changed = applyBusinessManagement(snapshot, { operations: [{ kind: 'update_manual_action', id: 'manual', patch: { title: 'Explicit title' } }] }, 'read-edit-action')
    expect(changed.snapshot.data.actions[0]).toMatchObject({ title: 'Explicit title', leverage: 81, delayCost: 77 })
    expect(snapshot).toEqual(before)
  })
})

describe('MCP list uses the current recruiting stage date', () => {
  it('matches Web order while retaining the separate old application deadline fact', () => {
    const pending = { ...opportunity('pending'), deadline: '2026-10-08T10:00:00Z' }
    const interview = { ...opportunity('interview'), deadline: '2026-10-01T10:00:00Z', processStage: 'interview' as const, currentStageLabel: '面试' }
    const snapshot = createSnapshot({ opportunities: [interview, pending], processes: [], prep: [], applicationGroups: [],
      processEvents: [{ id: 'invite', opportunityId: 'interview', company: interview.company, role: interview.role, type: 'interview_invite', occurredAt: at, dueAt: '2026-10-10T10:00:00Z', timingMode: 'fixed', estimatedMinutes: 60, source: 'manual', createdAt: at, updatedAt: at }],
      actions: [{ id: 'apply-pending', opportunityId: 'pending', kind: 'apply', title: 'Apply', dueAt: pending.deadline, timingMode: 'deadline', estimatedMinutes: 30, leverage: 0, delayCost: 0, status: 'todo', createdAt: at, updatedAt: at }, { id: 'event-action:invite', opportunityId: 'interview', processEventId: 'invite', processStage: 'interview', kind: 'manual', title: 'Interview', dueAt: '2026-10-10T10:00:00Z', timingMode: 'fixed', estimatedMinutes: 60, leverage: 0, delayCost: 0, status: 'todo', createdAt: at, updatedAt: at }] }, at)
    const context = { now: new Date(at), timezone: 'UTC' }, before = structuredClone(snapshot)
    const web = buildOpportunityDecisionList(snapshot, context)
    const mcp = listOpportunities(snapshot, {}, context)
    expect(mcp.opportunities.map(item => item.opportunityId)).toEqual(['pending', 'interview'])
    expect(mcp.opportunities.map(item => item.opportunityId)).toEqual(web.all.map(item => item.opportunityId))
    expect(mcp.opportunities[1]).toMatchObject({ applicationDeadline: '2026-10-01T10:00:00Z', currentActionDueAt: '2026-10-10T10:00:00Z', currentActionTimingMode: 'fixed' })
    expect(snapshot).toEqual(before)
  })
})

describe('compatibility Today timing uses canonical source evidence', () => {
  it.each(['estimated_date', 'system_estimate', 'cancelled'] as const)('does not expose a retained raw date for %s evidence', mode => {
    const snapshot = fixture()
    snapshot.data.actions[0].dueAt = '2026-10-07T10:00:00Z'
    snapshot.data.actions[0].timingMode = 'deadline'
    snapshot.data.scheduleNodes = [{ id: 'canonical-time', occurrenceId: 'canonical-time', version: 1,
      kind: 'prep_trigger', state: mode === 'cancelled' ? 'cancelled' : 'scheduled', constraintKind: 'system_suggestion',
      temporal: { shape: mode === 'estimated_date' ? 'estimated_date' : 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-10-07', resolutionBasis: mode === 'system_estimate' ? 'system_estimate' : 'user_explicit' },
      relatedActionIds: ['manual'], relatedPrepIds: [], evidenceRefs: ['synthetic'], sourceVersionRefs: [], createdAt: at, updatedAt: at }]
    const before = structuredClone(snapshot)
    const read = getTodayPlan(snapshot, { availableMinutes: 60 }, { now: new Date(at), timezone: 'UTC' })
    const action = read.startableActions.find(item => item.actionId === 'manual')
    expect(action).toBeDefined()
    expect(action!.dueAt).toBeUndefined()
    expect(read.fixedEvents).toEqual([])
    expect(snapshot).toEqual(before)
  })
})

describe('date-only source timezone survives MCP projections', () => {
  it('uses canonical source days for cutoff filtering and quota ordering without inventing timestamps', () => {
    const snapshot = fixture()
    snapshot.data.opportunities = ['a-west', 'z-east'].map(id => ({ ...opportunity(id), applicationGroupId: 'quota', deadline: '2026-10-07', deadlinePrecision: 'date' }))
    snapshot.data.applicationGroups = [{ id: 'quota', company: 'Synthetic', remaining: 1 }]
    snapshot.data.actions = []
    snapshot.data.scheduleNodes = snapshot.data.opportunities.map(item => ({ id: item.id, occurrenceId: item.id, version: 1, opportunityId: item.id,
      kind: 'application_deadline', state: 'scheduled', constraintKind: 'employer_hard',
      temporal: { shape: 'date_only', precision: 'date', timezone: item.id === 'a-west' ? 'America/Los_Angeles' : 'Asia/Tokyo', date: '2026-10-07', resolutionBasis: 'source_explicit' },
      relatedActionIds: [], relatedPrepIds: [], evidenceRefs: ['synthetic'], sourceVersionRefs: [], createdAt: at, updatedAt: at }))
    const context = { now: new Date(at), timezone: 'UTC' }
    const filtered = listOpportunities(snapshot, { deadlineBefore: '2026-10-08T00:00:00Z' }, context)
    expect(filtered.opportunities.map(item => item.opportunityId)).toEqual(['z-east'])
    expect(filtered.opportunities[0]).toMatchObject({ applicationDeadline: '2026-10-07', applicationDeadlinePrecision: 'date', applicationDeadlineTimezone: 'Asia/Tokyo' })
    expect(getApplicationPortfolio(snapshot, {}, context).decisions[0].candidates.map(item => item.opportunityId)).toEqual(['z-east', 'a-west'])
  })
})
