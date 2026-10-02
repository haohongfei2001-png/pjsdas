import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const css = read('src/secondarySurfaces.css')
describe('secondary-surface styling stays outside the protected main UI', () => {
  it('has no global reset, shell token or main-list selector', () => {
    const forbidden = /(?:^|[\s,])(?:body|html|:root|\.cgr-app-shell|\.tsui-topbar|\.tsui-today|\.tsui-task-row|\.tsui-job-open|\.tsui-primary-nav|\.tsui-schedule-row)(?:[\s,:.#>{]|$)/
    postcss.parse(css).walkRules(rule => expect(rule.selector, rule.selector).not.toMatch(forbidden))
  })
  it('only scopes main-container rules to a specific secondary child', () => {
    postcss.parse(css).walkRules(rule => {
      if (rule.selector.includes('.cgr-main')) expect(rule.selector).toMatch(/^\.cgr-main\.surface-main > \.(settings-surface|cgr-missing-opportunity)$/)
    })
  })
  it('preserves a visible high-contrast keyboard outline and 44px controls', () => {
    expect(css).toContain('outline: 3px solid #315ec5 !important')
    expect(css).toContain('min-height: 44px')
    expect(css).not.toMatch(/outline\s*:\s*(?:none|0)\b/)
  })
  it('styles the actual backup action articles', () => {
    expect(css).toContain('.backup-dialog .backup-actions-grid > article')
    expect(css).not.toContain('.backup-actions-grid > section')
  })
  it('loads the confined layer after the legacy global styles', () => {
    const main = read('src/main.tsx')
    expect(main.indexOf("import './secondarySurfaces.css'")).toBeGreaterThan(main.indexOf("import './productTruth.css'"))
  })
  it('compares actual main pixels to the exact deployed reference, without retries', () => {
    const workflow = read('.github/workflows/secondary-surfaces-ui.yml')
    expect(workflow).toContain('TA_SECONDARY_BASE: 1fa12d02ac5073bac0e82b419e1162d0ae84fdea')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('timeout-minutes: 15')
    expect(read('playwright.secondary-ui.config.mts')).toContain('retries: 0')
    expect(read('e2e/secondarySurfaces.ui.ts')).toContain('toBe(digest(baseline))')
  })
})
