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

  it('removes manual capture from Today and keeps it available in Settings', () => {
    const todayStart = app.indexOf('function TodaySurface')
    const todayEnd = app.indexOf('function OpportunitiesSurface')
    const settingsStart = app.indexOf('function SettingsSurface')
    const today = app.slice(todayStart, todayEnd)
    const settings = app.slice(settingsStart)

    expect(today).not.toContain('ProgressInbox')
    expect(today).not.toContain('ProcessEventDock')
    expect(today).not.toContain('today-manual-fallback')
    expect(settings).toContain('ProgressInbox')
    expect(settings).toContain('ProcessEventDock')
    expect(settings).toContain("zh ? '手工记录' : 'Manual capture'")
  })

  it('keeps first-level navigation decision-oriented and moves Activity under Settings', () => {
    expect(app).toContain("const primarySurfaces: Surface[] = ['today', 'opportunities', 'attention', 'settings']")
    expect(app).toContain("onOpenActivity={() => setSurface('activity')}")
    expect(app).toContain("zh ? '历史与审计' : 'History & audit'")
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
