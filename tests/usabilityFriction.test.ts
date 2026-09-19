import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')

describe('AI-operated Web console friction rules', () => {
  it('keeps action completion reversible through the existing status ChangeSet path', () => {
    expect(app).toContain('lastCompletedAction')
    expect(app).toContain("applyActionStatusChangeSet(item.id, item.previousStatus)")
    expect(app).toContain('action-undo-toast')
    expect(app).not.toContain('updateActionStatus(')
  })

  it('keeps manual capture as a fallback instead of the primary Today control', () => {
    expect(app).toContain('today-manual-fallback')
    expect(app).toContain('ProgressInbox')
    expect(app).toContain('ProcessEventDock')
    expect(app.indexOf('surface-focus-card')).toBeLessThan(app.indexOf('today-manual-fallback'))
  })

  it('chooses Opportunities context from active recruiting state without creating a review tab', () => {
    expect(app).toContain('opportunityTabExplicit')
    expect(app).toContain("setOpportunityTab(hasPipeline ? 'pipeline' : 'opportunities')")
    expect(app).toContain("setOpportunityTabExplicit(true)")
    expect(app).not.toContain("'review' | 'opportunities'")
  })

  it('keeps an empty workspace start path without persistent onboarding state', () => {
    expect(app).toContain('workspaceEmpty')
    expect(app).toContain('GettingStartedCard')
    expect(app).toContain("setSurface('settings')")
    expect(app).not.toContain('onboardingCompleted')
  })
})
