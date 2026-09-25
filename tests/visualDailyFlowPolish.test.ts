import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const today = readFileSync(new URL('../src/today/TodayFeature.tsx', import.meta.url), 'utf8')
const tsuiCss = readFileSync(new URL('../src/tsui02.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../src/cgr02Tokens.css', import.meta.url), 'utf8')

describe('UU-04 final Web visual hierarchy', () => {
  it('keeps the established design-system layers and adds the Ultimate Web layer', () => {
    expect(entry).toContain("import './designSystem.css'")
    expect(entry).toContain("import './visualPolish.css'")
    expect(app).toContain("import './ultimateWeb.css'")
  })

  it('renders equal task rows and an independently scrolling node panel', () => {
    expect(today).toContain('tsui-task-row')
    expect(today).toContain('tsui-node-panel')
    expect(today).toContain('selection.actions.map')
    expect(today).not.toContain('cgr-primary-action')
    expect(app).toContain("import './tsui02.css'")
    expect(app).not.toContain('function TodaySurface')
  })

  it('keeps three mobile destinations and a global Tell action', () => {
    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities', 'schedule']")
    expect(app).toContain('tsui-tell-button')
    expect(today).toContain('tsui-mobile-switch')
    expect(tsuiCss).toContain('@media(max-width:700px)')
  })

  it('provides visible focus, reduced motion and touch-sized primary controls', () => {
    expect(tokens).toContain(':focus-visible')
    expect(tokens).toContain('@media (prefers-reduced-motion: reduce)')
    expect(tsuiCss).toContain('min-height:44px')
    expect(tokens).toContain('--cgr-space-')
  })
})
