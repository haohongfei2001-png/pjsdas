import type { Action, ScheduleNode } from './model.js'
import { ensureScheduleContractInPlace, type ScheduleContractData } from './scheduleNodes.js'

export interface ActionStatusUndo {
  actions: Array<{ before: Action; after: Action }>
  scheduleNodes: Array<{ before: ScheduleNode; after: ScheduleNode }>
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}
function equal(a: unknown, b: unknown) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)) }
function occurrenceState(node: ScheduleNode) {
  return { state: node.state, completedAt: node.completedAt, cancelledAt: node.cancelledAt, updatedAt: node.updatedAt }
}

// Capture from normalized pre/post command snapshots, never infer ownership from
// timestamps or the action's relationship to already completed occurrences.
export function captureActionStatusUndo(before: ScheduleContractData, after: ScheduleContractData, actionIds: string[]): ActionStatusUndo {
  return {
    actions: actionIds.map((id) => {
      const prior = before.actions.find((item) => item.id === id)
      const current = after.actions.find((item) => item.id === id)
      if (!prior || !current) throw new Error('Action status compensation cannot be captured safely.')
      return { before: structuredClone(prior), after: structuredClone(current) }
    }),
    scheduleNodes: (before.scheduleNodes ?? []).flatMap((prior) => {
      const current = after.scheduleNodes?.find((item) => item.id === prior.id)
      return current && !equal(occurrenceState(prior), occurrenceState(current))
        ? [{ before: structuredClone(prior), after: structuredClone(current) }] : []
    }),
  }
}

export function restoreActionStatusUndo(data: ScheduleContractData, undo: ActionStatusUndo) {
  if (!Array.isArray(undo.actions) || !undo.actions.length || !Array.isArray(undo.scheduleNodes)) {
    throw new Error('Action status compensation evidence is invalid.')
  }
  // Validate the entire affected set before mutating any object. Later edits,
  // replacements and missing occurrences fail closed, including local-tab races.
  for (const { before, after } of undo.actions) {
    if (!before?.id || before.id !== after?.id || !equal(data.actions.find((item) => item.id === after.id), after)) {
      throw new Error('Action changed after completion; Undo cannot be applied safely.')
    }
  }
  for (const { before, after } of undo.scheduleNodes) {
    if (!before?.id || before.id !== after?.id || !equal(data.scheduleNodes?.find((item) => item.id === after.id), after)) {
      throw new Error('Schedule occurrence changed after completion; Undo cannot be applied safely.')
    }
  }
  for (const { before } of undo.actions) {
    data.actions[data.actions.findIndex((item) => item.id === before.id)] = structuredClone(before)
  }
  for (const { before, after } of undo.scheduleNodes) {
    // Restore business state while retaining every provenance reference created
    // by the completed command. Its timeline/receipt also remains in history.
    data.scheduleNodes![data.scheduleNodes!.findIndex((item) => item.id === before.id)] = {
      ...structuredClone(before),
      evidenceRefs: [...new Set([...before.evidenceRefs, ...after.evidenceRefs])],
      sourceVersionRefs: [...new Set([...before.sourceVersionRefs, ...after.sourceVersionRefs])],
    }
  }
  ensureScheduleContractInPlace(data)
}
