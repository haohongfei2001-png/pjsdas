import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const legacyCss = readFileSync(new URL('../src/ultimateWeb.css', import.meta.url), 'utf8')
const today = readFileSync(new URL('../src/today/TodayFeature.tsx', import.meta.url), 'utf8')
const todayCss = readFileSync(new URL('../src/today/today.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../src/cgr02Tokens.css', import.meta.url), 'utf8')

describe('UU-04 final Web visual hierarchy', () => {
  it('keeps the established design-system layers and adds the Ultimate Web layer', () => {
    expect(entry).toContain("import './designSystem.css'")
    expect(entry).toContain("import './visualPolish.css'")
    expect(app).toContain("import './ultimateWeb.css'")
  })

  it('makes the migrated Today action-and-agenda first instead of status-first', () => {
    expect(today).toContain('cgr-today-header')
    expect(today).toContain('cgr-primary-action')
    expect(today).toContain('cgr-agenda')
    expect(today).toContain('cgr-next-section')
    expect(today).toContain('brief.recentChanges')
    expect(today).not.toContain('today-status-strip')
    expect(today).not.toContain('today-manual-fallback')
    expect(todayCss).toContain('grid-template-columns: minmax(0, 1.55fr) minmax(310px, .78fr)')
    expect(app).not.toContain('function TodaySurface')
  })

  it('keeps iPhone navigation to Today / Opportunities with Tell PJSDAS above the tabs', () => {
    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities']")
    expect(legacyCss).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(legacyCss).toContain('.ultimate-mobile-capture')
    expect(legacyCss).toContain('bottom:calc(78px + env(safe-area-inset-bottom))')
    expect(todayCss).toContain('@media (max-width: 640px)')
  })

  it('provides visible focus, reduced motion and touch-sized primary controls', () => {
    expect(tokens).toContain(':focus-visible')
    expect(tokens).toContain('@media (prefers-reduced-motion: reduce)')
    expect(todayCss).toContain('min-height: 40px')
    expect(tokens).toContain('--cgr-space-')
  })
})
