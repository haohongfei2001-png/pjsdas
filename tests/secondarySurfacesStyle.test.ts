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
  it('compares actual main pixels to the fixed approved real-page reference, without retries', () => {
    const workflow = read('.github/workflows/secondary-surfaces-ui.yml')
    expect(workflow).toContain('TA_SECONDARY_BASE: dbad72074299c8f585a9b13d5f4ae0b3a6b32116')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('timeout-minutes: 15')
    expect(read('playwright.secondary-ui.config.mts')).toContain('retries: 0')
    expect(read('playwright.secondary-ui.config.mts')).toContain("args: ['--disable-skia-runtime-opts']")
    const pixelGate = read('e2e/secondarySurfaces.ui.ts')
    expect(pixelGate).toContain('toBe(digest(baseline))')
    expect(pixelGate).toContain("filter({ hasText: '可用时间' })).toHaveCount(0)")
    expect(pixelGate).toContain("name: '保存时段', exact: true })).toHaveCount(0)")
    expect(pixelGate).not.toContain("filter({ hasText: '可用时间' }).click()")
    expect(pixelGate).not.toMatch(/compareOutsideCaptureButton|repaintMainOnce|protectedMainPixels/)
  })
  it('bounds B3 Library changes while keeping exact old regions and both runtime contracts', () => {
    const gate = read('e2e/secondarySurfaces.ui.ts')
    expect(gate).toContain("await capture(page, 'MAIN_JOBS', width, scale)")
    for (const surface of ['MAIN_TODAY', 'MAIN_SCHEDULE', 'MAIN_AFTER_SETTINGS', 'MAIN_AFTER_CAPTURE']) {
      expect(gate).toContain(`await capture(page, '${surface}', width, scale, true)`)
    }
    for (const selector of ['.tsui-library-heading', '.tsui-library-panel', '.tsui-library-total']) expect(gate).toContain(selector)
    expect(gate).toContain('assertOriginalLibraryFilters(geometry.oldFilters, before.oldFilters)')
    expect(gate).toContain("const css = getComputedStyle(element, pseudo)")
    expect(gate).toContain('[...css].filter(key => pseudo || !dimensions.includes(key))')
    expect(gate).toContain("before: style(button, '::before'), after: style(button, '::after')")
    expect(gate).toContain('markup: button.innerHTML')
    expect(gate).toContain('disabled: button.disabled, tabIndex: button.tabIndex')
    expect(gate).toContain("active: button.classList.contains('active')")
    expect(gate).not.toContain('unchanged original filter pixels')
    expect(gate).toContain('assertLibraryFlow({ ...geometry.flow,')
    expect(gate).toContain('expect(geometry.filterStyle).toEqual(before.filterStyle)')
    expect(gate).toContain('geometry.scopeExtent + geometry.toolbar.height - before.toolbar.height')
    expect(gate).toContain('original eight Library queries, deadline order and 40-row paging')
    expect(gate).toContain("await capture(page, 'DISCOVERY_DETAIL', width, scale)")
    expect(gate).toContain("await capture(page, 'SEARCH_SCOPE', width, scale)")
    expect(gate).not.toMatch(/mask:|maxDiffPixels|maxDiffPixelRatio|pixelmatch|\.style\.(?:display|visibility)\s*=/)
  })
})
