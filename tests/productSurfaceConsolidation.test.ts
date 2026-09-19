import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

describe('AI-operated Web console information architecture', () => {
  it('keeps exactly five primary surfaces around work, exceptions, and audit', () => {
    expect(app).toContain("type Surface = 'today' | 'opportunities' | 'attention' | 'activity' | 'settings'")
    expect(app).not.toContain("type Surface = 'decide'")
    expect(app).not.toContain("type Surface = 'prepare'")
    expect(app).not.toContain("type Surface = 'history'")
  })

  it('keeps opportunity, pipeline, and preparation as one contextual working set', () => {
    expect(app).toContain("type OpportunityTab = 'opportunities' | 'pipeline' | 'prepare'")
    expect(app).toContain('<ApplicationPortfolioDock />')
    expect(app).toContain('<PrepGraphDock />')
    expect(app).toContain("onTabChange('prepare')")
  })

  it('separates intervention from audit instead of mixing ChangeSet review into Activity', () => {
    expect(app).toContain('<AttentionView timeline={timeline} changeSets={changeSets}')
    expect(app).toContain('<TimelineView records={timeline} />')
    expect(app).not.toContain('HistorySurface')
  })

  it('keeps specialist tools contextual instead of globally mounted', () => {
    expect(entry).toContain("import App from './AppV8.js'")
    expect(entry).not.toContain('ApplicationPortfolioDock')
    expect(entry).not.toContain('PrepGraphDock')
    expect(entry).not.toContain('ProgressInbox')
    expect(entry).not.toContain('ProcessEventDock')
    expect(entry).not.toContain('LocalBackupDock')
    expect(entry).toContain('FixedEventGuard')
  })
})
