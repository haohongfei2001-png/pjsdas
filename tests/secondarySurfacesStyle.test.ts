import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const css = read('src/secondarySurfaces.css')
const captureFocus = '.cgr-capture-sheet :is(button, a, input, select, textarea, summary, .cgr-understanding):focus-visible'
const composerFocus = '.cgr-capture-sheet .cgr-capture-composer:has(.cgr-capture-input:focus-visible)'
const inputFocus = '.cgr-capture-sheet .cgr-capture-input:focus-visible'

function expectVisibleFocus(source: string) {
  const root = postcss.parse(source)
  const removals: postcss.Declaration[] = []
  root.walkDecls(declaration => {
    if (/^outline(?:-style|-width)?$/i.test(declaration.prop) && /^(?:none\b|[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?(?:\s|$))/i.test(declaration.value)) removals.push(declaration)
  })
  // The sole exception transfers textarea focus to the containing composer.
  // Other controls and browsers without :has keep their own visible outline.
  expect(removals).toHaveLength(1)
  const removal = removals[0]!
  expect(removal.prop).toBe('outline')
  expect(removal.value).toBe('none')
  expect(removal.important).toBe(true)
  const input = removal.parent as postcss.Rule
  expect(input.type).toBe('rule')
  expect(input.selector).toBe(inputFocus)
  const support = input.parent as postcss.AtRule
  expect(support.type).toBe('atrule')
  expect(support.name).toBe('supports')
  expect(support.params).toBe('selector(:has(*))')
  const ring = support.nodes?.find(node => node.type === 'rule' && node.selector === composerFocus) as postcss.Rule | undefined
  expect(ring).toBeDefined()
  const declarations = (rule: postcss.Rule) => rule.nodes.filter(node => node.type === 'decl').map(node => `${node.prop}:${node.value}${node.important ? '!important' : ''}`)
  expect(declarations(ring!)).toEqual(expect.arrayContaining(['outline:2px solid #315ec5', 'outline-offset:0', 'border-color:transparent']))
  const fallback = root.nodes.find(node => node.type === 'rule' && node.selector === captureFocus) as postcss.Rule | undefined
  expect(fallback).toBeDefined()
  expect(declarations(fallback!)).toEqual(expect.arrayContaining(['outline:2px solid #315ec5!important', 'outline-offset:2px!important']))
}

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
    expectVisibleFocus(css)
  })
  it.each([
    ['missing outer ring', () => css.replace('outline: 2px solid #315ec5;', 'outline: 1px solid #315ec5;')],
    ['wrong replacement target', () => css.replace(composerFocus, '.unrelated:focus-visible')],
    ['unconditional textarea suppression', () => `${css}\n${inputFocus} { outline: none !important; }`],
    ['another control loses focus', () => `${css}\n.cgr-capture-tool:focus-visible { outline: 0; }`],
    ['decimal zero hides settings focus', () => `${css}\n.settings-surface button:focus-visible { outline: 0.0px solid transparent !important; }`],
    ['zero with units hides focus', () => `${css}\n.cgr-capture-tool:focus-visible { outline-width: 0px !important; }`],
    ['fractional zero hides focus', () => `${css}\n.cgr-capture-tool:focus-visible { outline-width: .0rem !important; }`],
    ['missing fallback', () => css.replace(captureFocus, '.unrelated:focus-visible')],
  ] as const)('rejects %s in the single-ring contract', (_name, mutate) => {
    expect(() => expectVisibleFocus(mutate())).toThrow()
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
