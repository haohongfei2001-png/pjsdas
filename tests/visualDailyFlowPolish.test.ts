import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/ultimateWeb.css', import.meta.url), 'utf8')

describe('UU-04 final Web visual hierarchy', () => {
  it('keeps the established design-system layers and adds the Ultimate Web layer', () => {
    expect(entry).toContain("import './designSystem.css'")
    expect(entry).toContain("import './visualPolish.css'")
    expect(app).toContain("import './ultimateWeb.css'")
  })

  it('makes Today action-and-agenda first instead of status-first', () => {
    expect(app).toContain('ultimate-today-header')
    expect(app).toContain('ultimate-next-action')
    expect(app).toContain('ultimate-agenda')
    expect(app).toContain('ultimate-next-list-section')
    expect(app).not.toContain('today-status-strip')
    expect(app).not.toContain('today-manual-fallback')
    expect(css).toContain('.ultimate-today-layout')
    expect(css).toContain('grid-template-areas:"primary agenda" "next agenda"')
  })

  it('keeps iPhone navigation to Today / Opportunities with Tell PJSDAS above the tabs', () => {
    expect(app).toContain("const primarySurfaces: PrimarySurface[] = ['today', 'opportunities']")
    expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(css).toContain('.ultimate-mobile-capture')
    expect(css).toContain('bottom:calc(78px + env(safe-area-inset-bottom))')
    expect(css).toContain('grid-template-areas:"primary" "agenda" "next"')
  })

  it('provides visible focus, reduced motion and touch-sized primary controls', () => {
    expect(css).toContain(':focus-visible')
    expect(css).toContain('@media(prefers-reduced-motion:reduce)')
    expect(css).toContain('min-height:44px')
    expect(css).toContain('touch-action:manipulation')
  })
})
