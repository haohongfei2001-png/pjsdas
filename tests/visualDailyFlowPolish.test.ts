import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/AppV8.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/webConsole.css', import.meta.url), 'utf8')
const polish = readFileSync(new URL('../src/visualPolish.css', import.meta.url), 'utf8')

describe('AI-operated console visual hierarchy', () => {
  it('keeps the existing design-system/polish layers and adds the console layer', () => {
    expect(entry).toContain("import './designSystem.css'")
    expect(entry).toContain("import './visualPolish.css'")
    expect(app).toContain("import './webConsole.css'")
  })

  it('makes Today decision-first instead of status-first', () => {
    expect(app).toContain('decision-today-header')
    expect(app).toContain('decision-hero')
    expect(app).toContain('decision-next-section')
    expect(app).not.toContain('today-status-strip')
    expect(app).not.toContain('today-manual-fallback')
    expect(css).toContain('.decision-today-header')
    expect(css).toContain('.decision-hero')
    expect(css).toContain('.decision-next-section')
    expect(css).not.toContain('.today-status-strip')
    expect(css).not.toContain('.today-manual-fallback')
  })

  it('keeps mobile navigation aligned with the four decision surfaces', () => {
    expect(app).toContain("const primarySurfaces: Surface[] = ['today', 'opportunities', 'attention', 'settings']")
    expect(css).toContain('grid-template-columns:repeat(4,minmax(0,1fr))')
    expect(css).toContain('backdrop-filter:blur(24px) saturate(140%)')
  })

  it('keeps keyboard, reduced-motion, and mobile affordances from the existing polish layer', () => {
    expect(polish).toContain(':focus-visible')
    expect(polish).toContain('@media(prefers-reduced-motion:reduce)')
    expect(polish).toContain('.surface-nav-item{min-height:48px}')
    expect(css).toContain('@media(max-width:760px)')
  })
})
