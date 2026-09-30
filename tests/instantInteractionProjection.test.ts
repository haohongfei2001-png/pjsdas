import { describe, it, expect } from 'vitest'
import { interactionProjection, undoInteractionProjection } from '../src/cloud/interactionProjection.js'
import { applyWorkspaceDelta, diffWorkspaceDelta, reverseWorkspaceDelta } from '../src/workspaceDelta.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { applyDomainCompensation, applyUserDomainCommand, type UserDomainCommand } from '../src/domainCommands.js'
import { instantDenseWorkspace, INSTANT_NOW } from './fixtures/instantDenseWorkspace.js'
import { denseDecisionWorkspace, DENSE_NOW } from './fixtures/denseDecisionWorkspace.js'

describe('bounded interaction projection', () => {
  it.each(['submission', 'capacity', 'action', 'reschedule', 'cancel', 'complete'] as const)('projects %s Undo with exact kernel semantics and retained audit', kind => {
    const before = instantDenseWorkspace()
    before.data.processes = before.data.processes.filter(item => item.opportunityId !== 'dense-job-2')
    delete before.data.timePlanning
    const occurrenceId = before.data.scheduleNodes!.find(node => node.relatedActionIds.includes('dense-action-0'))!.occurrenceId
    const command: UserDomainCommand = kind === 'submission'
      ? { commandId: 'undo-kernel-submission', kind: 'record_application_submission', opportunityId: 'dense-job-2' }
      : kind === 'capacity' ? { commandId: 'undo-kernel-capacity', kind: 'set_date_capacity', date: '2026-10-01', minutes: 360 }
      : kind === 'action' ? { commandId: 'undo-kernel-action', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' }
      : kind === 'reschedule' ? { commandId: 'undo-kernel-reschedule', kind: 'reschedule_occurrence', occurrenceId, temporal: { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: '2026-10-02T15:59:59Z', resolutionBasis: 'user_asserted' } }
      : { commandId: `undo-kernel-${kind}`, kind: kind === 'cancel' ? 'cancel_occurrence' : 'complete_occurrence', occurrenceId }
    const forward = applyUserDomainCommand(before, command, INSTANT_NOW)
    expect(forward.status).toBe('APPLIED')
    if (forward.status !== 'APPLIED') return
    const delta = diffWorkspaceDelta(before, forward.snapshot, 1204)
    const undo = undoInteractionProjection(forward.snapshot, command, forward.compensation, delta, 1205, INSTANT_NOW)
    const optimistic = applyWorkspaceDelta(forward.snapshot, undo)
    const authoritative = applyDomainCompensation(forward.snapshot, forward.compensation!, INSTANT_NOW)
    expect(optimistic.data).toEqual(authoritative.data)
    expect(optimistic.data.timeline).toBe(forward.snapshot.data.timeline)
    const edited = structuredClone(forward.snapshot)
    if (kind === 'capacity') edited.data.timePlanning!.dateOverrides!['2026-10-01'] = 60
    else edited.data.actions.find(action => action.id === (kind === 'submission' ? 'apply:dense-job-2' : 'dense-action-0'))!.status = 'skipped'
    if (kind === 'capacity' || kind === 'action' || kind === 'submission' || kind === 'complete')
      expect(() => undoInteractionProjection(edited, command, forward.compensation, delta, 1205, INSTANT_NOW)).toThrow()
    if (kind === 'reschedule' || kind === 'cancel' || kind === 'complete') {
      const locallyEdited = structuredClone(forward.snapshot)
      const prior = forward.compensation!.payload.node ?? forward.compensation!.payload.previousNode
      locallyEdited.data.scheduleNodes!.find(node => node.id === prior.id)!.title = 'A genuine local node edit'
      expect(() => undoInteractionProjection(locallyEdited, command, forward.compensation, delta, 1205, INSTANT_NOW)).toThrow('安排已变化')
    }
  })
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
