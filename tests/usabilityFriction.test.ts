import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const capture = readFileSync(new URL('../src/TellPjsdasCapture.tsx', import.meta.url), 'utf8')
const today = readFileSync(new URL('../src/today/TodayFeature.tsx', import.meta.url), 'utf8')

describe('UU-04 Web friction rules', () => {
  it('keeps action completion reversible through the existing bounded status path', () => {
    expect(app).toContain('lastCompletedAction')
    expect(app).toContain("applyActionStatusChangeSet(item.id, item.previousStatus)")
    expect(app).toContain('action-undo-toast')
    expect(app).not.toContain('updateActionStatus(')
  })

  it('replaces daily manual capture with global Tell PJSDAS and keeps only recovery tooling in Settings', () => {
    const settingsStart = app.indexOf('function SettingsSurface')
    const settings = app.slice(settingsStart)

    expect(today).not.toContain('ProgressInbox')
    expect(today).not.toContain('ProcessEventDock')
    expect(today).not.toContain('today-manual-fallback')
    expect(app).not.toContain('function TodaySurface')
    expect(app).toContain('<TellPjsdasCapture')
    expect(app).not.toContain('ProgressInbox')
    expect(settings).toContain('ProcessEventDock')
    expect(settings).toContain("zh ? '流程恢复工具' : 'Process recovery'")
    expect(capture).toContain('submitWebSemanticCapture')
    expect(capture).not.toContain('ChangeSet')
  })

  it('keeps first-level navigation to two daily destinations and moves History/Settings to low-frequency routes', () => {
    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities']")
    expect(app).toContain("navigate('/settings')")
    expect(app).toContain("onOpenActivity={() => navigate('/history')}")
    expect(app).toContain("zh ? '历史与审计' : 'History & audit'")
  })

  it('keeps Opportunities decision-first without creating Pipeline or Review maintenance tabs', () => {
    expect(app).toContain("type OpportunityTab = 'opportunities' | 'prepare'")
    expect(app).toContain('OpportunityDecisionList')
    expect(app).toContain("setOpportunityTabExplicit(true)")
    expect(app).not.toContain("'review' | 'opportunities'")
    expect(app).not.toContain("'pipeline' | 'prepare'")
  })

  it('keeps an empty workspace start path without persistent onboarding state', () => {
    expect(app).toContain('workspaceEmpty')
    expect(today).toContain('workspaceEmpty')
    expect(today).toContain("zh ? '先让 PJSDAS 知道你的求职现状'")
    expect(app).toContain("navigate('/settings')")
    expect(app).not.toContain('onboardingCompleted')
  })
})
