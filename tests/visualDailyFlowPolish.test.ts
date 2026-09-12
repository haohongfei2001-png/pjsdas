import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/visualPolish.css', import.meta.url), 'utf8')

describe('v1.8 Round 3 visual hierarchy and daily flow', () => {
  it('loads the polish layer after the base design system', () => {
    expect(entry).toContain("import './designSystem.css'")
    expect(entry).toContain("import './visualPolish.css'")
    expect(entry.indexOf("designSystem.css")).toBeLessThan(entry.indexOf("visualPolish.css"))
  })

  it('keeps Today action-first and maintenance secondary', () => {
    expect(css).toContain('.today-surface>.surface-focus-card{order:1}')
    expect(css).toContain('.today-surface>.surface-two-column{order:2}')
    expect(css).toContain('.today-surface>.surface-tool-strip{order:4}')
    expect(css).toContain('.surface-focus-card{border:1px solid rgba(23,32,45,.85)!important')
  })

  it('preserves keyboard and reduced-motion accessibility while polishing mobile flow', () => {
    expect(css).toContain(':focus-visible')
    expect(css).toContain('@media(prefers-reduced-motion:reduce)')
    expect(css).toContain('.surface-context-tabs{position:sticky')
    expect(css).toContain('.surface-nav-item{min-height:48px}')
    expect(css).toContain('.surface-focus-actions button{min-height:44px}')
  })
})
