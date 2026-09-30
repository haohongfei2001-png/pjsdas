import { describe, it, expect } from 'vitest'
import { interactionProjection } from '../src/cloud/interactionProjection.js'
import { applyWorkspaceDelta, diffWorkspaceDelta, reverseWorkspaceDelta } from '../src/workspaceDelta.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { denseDecisionWorkspace, DENSE_NOW } from './fixtures/denseDecisionWorkspace.js'

describe('bounded interaction projection', () => {
  it('has kernel-equivalent action/submission/capacity projections without visiting history', () => {
    const before = upgradeSnapshotToLatest(denseDecisionWorkspace())
    before.data.timeline = []
    const commands = [
      { commandId: 'instant-action-001', kind: 'set_action_status' as const, actionId: 'dense-action-361', status: 'todo' as const },
      { commandId: 'instant-capacity-001', kind: 'set_date_capacity' as const, date: '2026-09-29', minutes: 360 },
    ]
    for (const command of commands) {
      const projection = interactionProjection(before, command, 1004, DENSE_NOW)
      const patched = applyWorkspaceDelta(before, projection.delta)
      const expected = applyUserDomainCommand(before, command, DENSE_NOW).snapshot
      expect(patched.data.actions).toEqual(expected.data.actions)
      expect(patched.data.timePlanning).toEqual(expected.data.timePlanning)
      expect(patched.data.scheduleNodes).toEqual(expected.data.scheduleNodes)
      expect(applyWorkspaceDelta(patched, reverseWorkspaceDelta(projection.delta)).data).toEqual(before.data)
    }
  })
  it('keeps independent fields and refuses contradictory field changes', () => {
    const before = upgradeSnapshotToLatest(denseDecisionWorkspace())
    before.data.timeline = []
    const after = applyUserDomainCommand(before, { commandId: 'delta-action-001', kind: 'set_action_status', actionId: 'dense-action-330', status: 'done' }, DENSE_NOW).snapshot
    const delta = diffWorkspaceDelta(before, after)
    const concurrent = structuredClone(before)
    concurrent.data.actions[330].title = 'Independent newer title'
    expect(applyWorkspaceDelta(concurrent, delta).data.actions[330]).toMatchObject({ title: 'Independent newer title', status: 'done' })
    concurrent.data.actions[330].status = 'skipped'
    expect(() => applyWorkspaceDelta(concurrent, delta)).toThrow('LOCAL_FIELD_CONFLICT')
  })
})
