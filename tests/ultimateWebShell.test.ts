import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const legacyCss = readFileSync(new URL('../src/ultimateWeb.css', import.meta.url), 'utf8')
const today = readFileSync(new URL('../src/today/TodayFeature.tsx', import.meta.url), 'utf8')
const todayCss = readFileSync(new URL('../src/today/today.css', import.meta.url), 'utf8')
const capture = readFileSync(new URL('../src/TellPjsdasCapture.tsx', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('../src/webSemanticIntake.ts', import.meta.url), 'utf8')

describe('UU-04 final Web shell contract', () => {
  it('implements all frozen semantic routes without adding daily destinations', () => {
    for (const route of [
      '/today',
      '/today/agenda',
      '/opportunities',
      '/opportunities/',
      '/capture',
      '/today/capture',
      '/decisions',
      '/settings',
      '/history',
    ]) expect(app).toContain(route)

    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities']")
    expect(app).not.toContain("primarySurfaces: PrimarySurface[] = ['today', 'opportunities',")
  })

  it('projects Web Today from the canonical TodayBrief instead of recomputing a parallel daily model', () => {
    expect(app).toContain('buildTodayBrief(')
    expect(app).toContain('brief={todayBrief}')
    expect(today).toContain('brief.nextAction')
    expect(today).toContain('brief.agendaGroups')
    expect(today).toContain('brief.recentChanges')
    expect(app).not.toContain('const ranked = useMemo(() => rankActions')
    expect(app).not.toContain('const plan = buildTimePlan')
  })

  it('preserves user context across background workspace refreshes', () => {
    expect(entry).toContain('return <App />')
    expect(entry).not.toContain('key={revision}')
    expect(app).toContain("window.addEventListener('pjsdas:workspace-replaced', refresh)")
    expect(app).toContain("window.addEventListener('popstate', pop)")
    expect(app).toContain("window.history.pushState")
  })

  it('routes global capture through the UU-02 Semantic Intake kernel instead of ChangeSet UI', () => {
    expect(app).toContain('<TellPjsdasCapture')
    expect(capture).toContain('submitWebSemanticCapture')
    expect(adapter).toContain('applySemanticIntake')
    expect(adapter).toContain('resolveSemanticDecision')
    expect(adapter).toContain('applySemanticCompensation')
    expect(adapter).toContain('fingerprintWorkspace')
    expect(capture).not.toContain('ChangeSet')
    expect(app).not.toContain('ProgressInbox')
  })

  it('keeps the migrated Today hierarchy responsive without reviving the old daily surface', () => {
    expect(todayCss).toContain('@media (max-width: 640px)')
    expect(todayCss).toContain('.cgr-primary-action')
    expect(todayCss).toContain('.cgr-agenda')
    expect(todayCss).toContain('.cgr-next-section')
    expect(today.indexOf('cgr-primary-action')).toBeLessThan(today.indexOf('cgr-next-section'))
    expect(today.indexOf('cgr-primary-action')).toBeLessThan(today.indexOf('cgr-agenda'))
    expect(legacyCss).toContain('.ultimate-mobile-capture')
    expect(app).not.toContain('function TodaySurface(')
  })

  it('keeps Decisions conditional and low-frequency controls outside primary navigation', () => {
    expect(app).toContain('openDecisionCount > 0')
    expect(app).toContain("navigate('/decisions')")
    expect(app).toContain("navigate('/settings')")
    expect(app).toContain("navigate('/history')")
    expect(app).not.toContain('<AttentionView')
  })
})
