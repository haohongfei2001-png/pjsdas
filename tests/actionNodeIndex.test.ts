import { describe, expect, it } from 'vitest'
import { actionNodesById } from '../src/deadlineOrder.js'
import { applicationDeadlineNodes, deadlineNodeFacts } from '../src/applicationDeadline.js'
import type { Action, Opportunity, ProcessEvent, ScheduleNode } from '../src/model.js'
import { referenceActionNodesById } from './fixtures/actionNodesByIdReference.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'

const now = '2026-10-07T08:00:00Z'
const action = (id: string): Action => ({ id, kind: 'manual', title: id, status: 'todo', estimatedMinutes: 10,
  leverage: 50, delayCost: 50, createdAt: now, updatedAt: now })
const node = (id: string): ScheduleNode => ({ id, occurrenceId: id, version: 1, kind: 'assessment', state: 'scheduled',
  constraintKind: 'employer_hard', relatedActionIds: [], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [],
  temporal: { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: now, resolutionBasis: 'source_explicit' },
  createdAt: now, updatedAt: now })
const opportunity = (id: string): Opportunity => ({ id, company: id, role: 'Role', roleType: 'core',
  processStage: 'not_applied', currentStageLabel: '待投', opportunityValue: 50, fitScore: 50, early: false,
  importedAt: now })
const event = (id: string): ProcessEvent => ({ id, opportunityId: 'o0', company: 'Company', role: 'Role',
  type: 'written_test_invite', occurredAt: now, source: 'manual', createdAt: now, updatedAt: now })

function assertEquivalent(nodes: ScheduleNode[], actions: Action[], opportunities: Opportunity[] = [], events: ProcessEvent[] = []) {
  const before = structuredClone({ nodes, actions, opportunities, events })
  expect([...actionNodesById(nodes, actions, opportunities, events)])
    .toEqual([...referenceActionNodesById(nodes, actions, opportunities, events)])
  expect({ nodes, actions, opportunities, events }).toEqual(before)
}

describe('indexed timing ownership preserves the scan-based contract', () => {
  it('keeps first live event and opportunity, latest-occurrence insertion order and stable arrangement ties', () => {
    const task = { ...action('a'), opportunityId: 'o', processEventId: 'event' }
    const cancelled = { ...node('old'), occurrenceId: 'same', version: 1, state: 'cancelled' as const, relatedActionIds: ['a'] }
    const first = { ...node('z-first'), occurrenceId: 'same', version: 2, relatedActionIds: ['a'], constraintKind: 'user_plan' as const,
      temporal: { shape: 'fixed_range' as const, precision: 'datetime' as const, timezone: 'UTC', startAt: now, endAt: '2026-10-07T09:00:00Z', resolutionBasis: 'user_explicit' as const } }
    const tied = { ...first, id: 'a-later', occurrenceId: 'different' }
    const duplicate = { ...first, id: 'ignored-same-version' }
    const live = { ...event('event'), opportunityId: 'o', temporal: node('n').temporal }
    const invalid = { ...live, invalidation: { reason: 'wrong', invalidatedAt: now } } as ProcessEvent
    assertEquivalent([cancelled, tied, first, duplicate], [task], [opportunity('o'), { ...opportunity('o'), role: 'Ignored' }], [invalid, live, { ...live, temporal: undefined }])
    expect(actionNodesById([cancelled, tied, first], [task]).get('a')?.id).toBe('z-first')
    assertEquivalent([], [task], [], [invalid, live, { ...live, temporal: undefined }])
  })

  it('retains canonical correction, withdrawal, source conflicts and independent live owners', () => {
    const { data } = unknownDeadlineWorkspace(8, true)
    assertEquivalent(data.scheduleNodes ?? [], data.actions, data.opportunities, data.processEvents)
    assertEquivalent([...(data.scheduleNodes ?? [])].reverse(), [...data.actions].reverse(), data.opportunities, data.processEvents)
    const job = data.opportunities[0]!, correction = job.detail!.deadlineCorrections!.at(-1)!
    correction.acknowledgedNodeFacts = deadlineNodeFacts(applicationDeadlineNodes(data, job.id))
    correction.state = 'confirmed'; correction.deadline = '2026-10-10'; correction.precision = 'date'
    assertEquivalent(data.scheduleNodes ?? [], data.actions, data.opportunities, data.processEvents)
    expect(actionNodesById(data.scheduleNodes ?? [], data.actions, data.opportunities, data.processEvents).get(data.actions[0]!.id)?.completionDeadline?.deadline).toBe('2026-10-10')
    correction.acknowledgedNodeFacts = 'stale-node-facts'
    assertEquivalent(data.scheduleNodes ?? [], data.actions, data.opportunities, data.processEvents)
    expect(actionNodesById(data.scheduleNodes ?? [], data.actions, data.opportunities, data.processEvents).get(data.actions[0]!.id)?.completionDeadline?.deadline).toBeUndefined()
  })

  it('preserves empty defaults and missing or null optional links without selecting a later duplicate', () => {
    expect([...actionNodesById([], undefined, undefined, undefined)]).toEqual([])
    const task = { ...action('a'), processEventId: 'same' }
    const first = { ...event('same'), temporal: undefined }
    const later = { ...first, temporal: node('n').temporal }
    assertEquivalent([], [task], [], [first, later])
    expect(actionNodesById([], [task], [], [first, later]).has('a')).toBe(false)
    assertEquivalent([], [action('missing'), { ...action('null'), opportunityId: null, processEventId: null } as unknown as Action], [], [first])
    const { data } = unknownDeadlineWorkspace(1)
    const duplicate = { ...data.opportunities[0]!, detail: undefined }
    assertEquivalent(data.scheduleNodes ?? [], data.actions, [duplicate, ...data.opportunities], data.processEvents)
    assertEquivalent(data.scheduleNodes ?? [], data.actions, [...data.opportunities, duplicate], data.processEvents)
  })

  it('matches 200 seeded mixed histories including duplicate identities and ordering', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let value = seed
      const pick = (length: number) => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value % length }
      const opportunities = Array.from({ length: 9 }, (_, index) => opportunity(`o${index % 8}`))
      const actions = Array.from({ length: 25 }, (_, index): Action => ({ ...action(`a${index % 24}`),
        kind: pick(3) ? 'manual' : 'apply', opportunityId: pick(4) ? `o${pick(8)}` : undefined,
        processEventId: pick(3) ? `e${pick(8)}` : undefined, timingContractVersion: pick(2) ? 2 : undefined,
        dueAt: pick(2) ? now : undefined, duePrecision: 'datetime' }))
      const nodes = Array.from({ length: 40 }, (_, index): ScheduleNode => ({ ...node(`n${index}`),
        occurrenceId: `occ${pick(28)}`, version: pick(4) + 1, opportunityId: pick(3) ? `o${pick(8)}` : undefined,
        processEventId: pick(3) ? `e${pick(8)}` : undefined,
        kind: pick(3) ? 'assessment' : 'application_deadline', state: (['scheduled', 'cancelled', 'superseded', 'completed'] as const)[pick(4)],
        relatedActionIds: [`a${pick(24)}`, `a${pick(24)}`], constraintKind: pick(2) ? 'user_plan' : 'employer_hard',
        temporal: pick(2) ? node('n').temporal : { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: now,
          endAt: `2026-10-07T${10 + pick(3)}:00:00Z`, resolutionBasis: 'user_explicit' } }))
      const events = Array.from({ length: 12 }, (_, index): ProcessEvent => ({ ...event(`e${index % 8}`),
        opportunityId: `o${pick(8)}`, temporal: pick(2) ? node('n').temporal : undefined,
        timingMode: pick(2) ? 'fixed' : 'deadline' }))
      assertEquivalent(nodes, actions, opportunities, events)
    }
  })

  it('indexes explicit action links once rather than rescanning nodes for every action', () => {
    const actions = Array.from({ length: 1000 }, (_, index) => action(`a${index}`))
    let relationshipReads = 0
    const nodes = actions.map(item => {
      const value = { ...node(`n${item.id}`), constraintKind: 'user_plan' as const,
        temporal: { shape: 'fixed_range' as const, precision: 'datetime' as const, timezone: 'UTC', startAt: now,
          endAt: '2026-10-07T09:00:00Z', resolutionBasis: 'user_explicit' as const } }
      Object.defineProperty(value, 'relatedActionIds', { enumerable: true, get() { relationshipReads++; return [item.id] } })
      return value
    })
    const indexed = actionNodesById(nodes, actions)
    expect(indexed.size).toBe(actions.length)
    // Two index reads plus one spread into the derived owner per action.
    expect(relationshipReads).toBe(nodes.length * 3)
    expect([...indexed]).toEqual([...referenceActionNodesById(nodes, actions)])
  })
})
