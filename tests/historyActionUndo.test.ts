import { describe, expect, it } from 'vitest'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { HISTORY_NOW, historyActionWorkspace } from './fixtures/historyActionWorkspace.js'

function complete() {
  const before = historyActionWorkspace()
  const result = applyUserDomainCommand(before, { commandId: 'history-done', kind: 'set_action_status', actionId: 'history-task', status: 'done' }, HISTORY_NOW)
  if (result.status !== 'APPLIED' || !result.compensation) throw Error('Expected a reversible completion')
  return { before, result }
}

describe('task status and exact historical compensation', () => {
  it('undoes only changed occurrences after JSON persistence and preserves prior completions, elapsed and unknown history', () => {
    const { before, result } = complete()
    const restored = applyDomainCompensation(JSON.parse(JSON.stringify(result.snapshot)), JSON.parse(JSON.stringify(result.compensation)), new Date(HISTORY_NOW.getTime() + 1000))
    for (const node of before.data.scheduleNodes!) {
      const actual = restored.data.scheduleNodes!.find((item) => item.id === node.id)!
      expect(actual).toMatchObject({ state: node.state, updatedAt: node.updatedAt })
      expect(actual.completedAt).toBe(node.completedAt)
      for (const ref of node.sourceVersionRefs) expect(actual.sourceVersionRefs).toContain(ref)
    }
    expect(restored.data.timeline).toEqual(result.snapshot.data.timeline)
    expect(before.data.actions[0].status).toBe('todo')
    expect(restored.data.actions[0].status).toBe('todo')
  })
  for (const status of ['todo', 'doing', 'skipped'] as const) it(`generic ${status} never reopens terminal or elapsed history`, () => {
    const { result } = complete()
    const before = structuredClone(result.snapshot)
    const changed = applyUserDomainCommand(before, { commandId: 'history-reopen-' + status, kind: 'set_action_status', actionId: 'history-task', status }, new Date(HISTORY_NOW.getTime() + 1000))
    expect(changed.status).toBe('APPLIED')
    for (const node of before.data.scheduleNodes!) {
      const after = changed.snapshot.data.scheduleNodes!.find((item) => item.id === node.id)!
      expect({ state: after.state, completedAt: after.completedAt, cancelledAt: after.cancelledAt, updatedAt: after.updatedAt })
        .toEqual({ state: node.state, completedAt: node.completedAt, cancelledAt: node.cancelledAt, updatedAt: node.updatedAt })
      for (const ref of node.sourceVersionRefs) expect(after.sourceVersionRefs).toContain(ref)
    }
  })
  it('fails closed when an affected occurrence was changed or removed after completion', () => {
    const { result } = complete()
    for (const change of ['edit', 'remove']) {
      const later = structuredClone(result.snapshot)
      if (change === 'edit') later.data.scheduleNodes!.find((n) => n.id === 'history-node-6')!.temporal.deadlineAt = '2026-10-01T10:00:00+08:00'
      else later.data.scheduleNodes = later.data.scheduleNodes!.filter((n) => n.id !== 'history-node-6')
      expect(() => applyDomainCompensation(later, result.compensation!, HISTORY_NOW)).toThrow(/changed|safely/)
    }
  })
  it('legacy status-only compensation cannot guess ownership of historical occurrences', () => {
    const { result } = complete()
    expect(() => applyDomainCompensation(result.snapshot, { operation: 'set_action_status', payload: { actionId: 'history-task', status: 'todo' } }, HISTORY_NOW)).toThrow(/historical|evidence/)
  })
})

function applicationWorkspace() {
  const before = historyActionWorkspace()
  const task = before.data.actions[0]
  task.id = 'apply:history-job'; task.kind = 'apply'
  for (const node of before.data.scheduleNodes!) node.relatedActionIds = [task.id]
  return before
}
it('application submission Undo restores owned deadline changes without reopening prior history', () => {
  const before = applicationWorkspace()
  const result = applyUserDomainCommand(before, { commandId: 'submit-owned', kind: 'record_application_submission', opportunityId: 'history-job' }, HISTORY_NOW)
  if (result.status !== 'APPLIED' || !result.compensation) throw Error('Expected compensation')
  const restored = applyDomainCompensation(JSON.parse(JSON.stringify(result.snapshot)), JSON.parse(JSON.stringify(result.compensation)), HISTORY_NOW)
  expect(restored.data.actions[0].status).toBe('todo')
  for (const node of before.data.scheduleNodes!) {
    const actual = restored.data.scheduleNodes!.find(n => n.id === node.id)!
    expect(actual.state).toBe(node.state)
    expect(actual.completedAt).toBe(node.completedAt)
  }
  expect(restored.data.timeline).toEqual(result.snapshot.data.timeline)
  const edited = structuredClone(result.snapshot)
  edited.data.scheduleNodes!.find(n => n.id === 'history-node-6')!.temporal.deadlineAt = '2026-10-20T10:00:00+08:00'
  expect(() => applyDomainCompensation(edited, result.compensation!, HISTORY_NOW)).toThrow(/changed|safely/)
})
