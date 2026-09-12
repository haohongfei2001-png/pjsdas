import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const progressInbox = readFileSync(new URL('../src/ProgressInbox.tsx', import.meta.url), 'utf8')
const notificationPaste = readFileSync(new URL('../src/NotificationPasteDock.tsx', import.meta.url), 'utf8')
const processDock = readFileSync(new URL('../src/ProcessEventDock.tsx', import.meta.url), 'utf8')
const readLayer = readFileSync(new URL('../src/ai/readLayer.ts', import.meta.url), 'utf8')
const processEvents = readFileSync(new URL('../src/processEvents.ts', import.meta.url), 'utf8')

function position(source: string, needle: string) {
  const value = source.indexOf(needle)
  expect(value, `missing source contract: ${needle}`).toBeGreaterThanOrEqual(0)
  return value
}

describe('process lifecycle correctness contract', () => {
  it('keeps natural-language completion on the canonical ChangeSet path with unsuppressed mutation baselines', () => {
    expect(progressInbox).toContain('getAllActionsForMutationBaseline')
    expect(progressInbox).toContain('createCanonicalProgressChangeSet')
    expect(progressInbox).toContain('savePendingChangeSet(canonical)')
    expect(progressInbox).toContain('不重复创建测评/笔试/面试事件')
  })

  it('keeps every manual process-notification entry point on ChangeSet and fresh-workspace reads', () => {
    expect(notificationPaste).toContain('applyProcessEventChangeSet(event)')
    expect(notificationPaste).not.toContain('addProcessEvent(event)')
    expect(notificationPaste).toContain('const current = await getAllOpportunities()')

    expect(processDock).toContain("window.addEventListener('pjsdas:workspace-replaced', refresh)")
    expect(processDock).toContain('const latestOpportunities = await getAllOpportunities()')
    expect(processDock).toContain('applyProcessEventChangeSet(processEvent)')
  })

  it('projects completed process Action status before Opportunity/Pipeline AI reads diverge', () => {
    expect(processEvents).toContain('actions: Action[] = []')
    const reconcile = position(readLayer, 'const reconciledActions = reconcileProcessEventActions')
    const opportunities = position(readLayer, 'const opportunities = overlayProcessEventsOnOpportunities')
    const suppress = position(readLayer, 'const actions = suppressSupersededActions')
    expect(reconcile).toBeLessThan(opportunities)
    expect(opportunities).toBeLessThan(suppress)
    expect(readLayer).toContain('snapshot.data.processes,\n    reconciledActions,')
  })
})
