import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const today = readFileSync(new URL('../src/today/TodayFeature.tsx', import.meta.url), 'utf8')
const capture = readFileSync(new URL('../src/TellPjsdasCapture.tsx', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('../src/webSemanticIntake.ts', import.meta.url), 'utf8')

describe('UU-04 final Web shell contract', () => {
  it('implements compatibility routes and the approved primary destinations', () => {
    for (const route of [
      '/today',
      '/today/agenda',
      '/opportunities',
      '/library/',
      '/schedule',
      '/capture',
      '/today/capture',
      '/decisions',
      '/settings',
      '/history',
    ]) expect(app).toContain(route)

    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities', 'schedule']")
    expect(app).toContain("path === '/opportunities' || path === '/library'")
    expect(app).toContain("path === '/today/agenda' || path === '/schedule'")
  })

  it('projects complete Today and Schedule through their shared read models', () => {
    expect(app).toContain('selectTodayWeb(snapshot')
    expect(app).toContain('buildScheduleStream(snapshot')
    expect(app).toContain('selection={todayWeb}')
    expect(today).toContain('selection.actions.map')
    expect(today).toContain('ScheduleWindowList')
    expect(app).not.toContain('const ranked = useMemo(() => rankActions')
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

  it('renders equal task rows beside a progressive node panel', () => {
    expect(today).toContain('tsui-task-row')
    expect(today).toContain('tsui-node-panel')
    expect(today).toContain('tsui-mobile-switch')
    expect(today).not.toContain('cgr-primary-action')
    expect(app).toContain("import './tsui02.css'")
    expect(app).not.toContain('function TodaySurface(')
  })

  it('keeps Decisions conditional and low-frequency controls outside primary navigation', () => {
    expect(today).toContain('selection.decisions.map')
    expect(app).toContain("navigate('/decisions')")
    expect(app).toContain("navigate('/settings')")
    expect(app).toContain("navigate('/history')")
    expect(app).not.toContain('<AttentionView')
  })
})
