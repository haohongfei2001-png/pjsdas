import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

describe('UU-04 Web information architecture', () => {
  it('keeps exactly the three approved primary destinations', () => {
    expect(app).toContain("type Surface = 'today' | 'opportunities' | 'schedule' | 'decisions' | 'history' | 'settings'")
    expect(app).toContain("type PrimarySurface = 'today' | 'opportunities' | 'schedule'")
    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities', 'schedule']")
    expect(app).toContain("item === 'schedule' ? '/schedule' : '/library'")
    expect(app).not.toContain("type Surface = 'today' | 'opportunities' | 'attention'")
  })

  it('keeps opportunity decisions and preparation in one contextual working set without a separate Pipeline module', () => {
    expect(app).toContain("type OpportunityTab = 'opportunities' | 'prepare'")
    expect(app).toContain('<OpportunityDecisionList')
    expect(app).toContain('<PrepGraphDock />')
    expect(app).toContain("onTabChange('prepare')")
    expect(app).not.toContain("type OpportunityTab = 'opportunities' | 'pipeline' | 'prepare'")
    expect(app).not.toContain('<ApplicationPortfolioDock />')
  })

  it('uses DecisionRequest as the conditional intervention surface and History as audit only', () => {
    expect(app).toContain("<DecisionRequestsView requests={decisionRequests}")
    expect(app).toContain('onOpenDecision={(id) => navigate')
    expect(app).toContain("navigate('/decisions')")
    expect(app).toContain('<TimelineView records={timeline} />')
    expect(app).not.toContain('<AttentionView')
  })

  it('keeps specialist health/recovery tools out of the global daily shell', () => {
    expect(entry).toContain("import App from './AppV8.js'")
    expect(entry).not.toContain('ApplicationPortfolioDock')
    expect(entry).not.toContain('PrepGraphDock')
    expect(entry).not.toContain('ProgressInbox')
    expect(entry).not.toContain('ProcessEventDock')
    expect(entry).not.toContain('LocalBackupDock')
    expect(entry).not.toContain('FixedEventGuard')
    expect(entry).not.toContain('CoverageIndicator')
    expect(entry).toContain('return <App />')
    expect(entry).not.toContain('key={revision}')
  })
})
