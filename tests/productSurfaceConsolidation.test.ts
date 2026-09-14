import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

describe('v1.8 product surface consolidation', () => {
  it('keeps exactly five user-goal primary surfaces', () => {
    expect(app).toContain("type Surface = 'today' | 'decide' | 'prepare' | 'history' | 'settings'")
    expect(app).not.toContain("type Surface = 'discovery'")
    expect(app).not.toContain("type Surface = 'pipeline'")
    expect(app).not.toContain("type Surface = 'rules'")
  })

  it('keeps Decide focused on actual opportunities and active recruiting flow', () => {
    expect(app).toContain("type DecideTab = 'opportunities' | 'pipeline'")
    expect(app).toContain('<ApplicationPortfolioDock />')
    expect(app).not.toContain('<DiscoveryInboxView />')
    expect(app).not.toContain('<ContinuousDiscoveryDock />')
    expect(app).not.toContain("onTabChange('review')")
  })

  it('keeps specialist tools contextual instead of globally mounted', () => {
    expect(entry).toContain("import App from './AppV8.js'")
    expect(entry).not.toContain('ApplicationPortfolioDock')
    expect(entry).not.toContain('ContinuousDiscoveryDock')
    expect(entry).not.toContain('PrepGraphDock')
    expect(entry).not.toContain('ProgressInbox')
    expect(entry).not.toContain('ProcessEventDock')
    expect(entry).not.toContain('LocalBackupDock')
    expect(entry).toContain('FixedEventGuard')
  })
})
