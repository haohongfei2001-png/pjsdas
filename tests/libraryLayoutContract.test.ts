import { describe, expect, it } from 'vitest'
import { assertLibraryFlow, assertOriginalLibraryFilters, type LibraryFlow } from '../e2e/support/libraryLayoutContract.js'
import { readFileSync } from 'node:fs'

function mobile(count = 9): LibraryFlow {
  const height = Math.ceil(count / 3) * 44
  return { toolbar: { x: 24, y: 100, width: 342, height: height + 12 + 44 }, filters: { x: 24, y: 100, width: 342, height },
    search: { x: 24, y: 100 + height + 12, width: 342, height: 44 }, panel: { x: 24, y: 100 + height + 12 + 44 + 20, width: 342, height: 200 },
    buttons: Array.from({ length: count }, (_, index) => {
      const row = Math.floor(index / 3), size = Math.min(3, count - row * 3), width = 342 / size
      return { x: 24 + index % 3 * width, y: 100 + row * 44, width, height: 44 }
    }), rowGap: 0, columnGap: 0, basis: 90, filterMarginBottom: 12, toolbarMarginBottom: 20, stacked: true }
}
describe('B3 bounded Library layout contract', () => {
  it('accepts exact fixed-baseline Chromium metrics including cumulative fractional flex widths', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/libraryLayoutBaseline.json', import.meta.url), 'utf8'))
    for (const sample of fixture.samples) expect(() => assertLibraryFlow(sample.flow)).not.toThrow()
  })
  it('accepts exactly packed original eight and approved ninth-query wrapping', () => {
    expect(() => assertLibraryFlow(mobile(8))).not.toThrow()
    expect(() => assertLibraryFlow(mobile(9))).not.toThrow()
  })
  it('rejects a 600px filter minimum height even if all later regions translate together', () => {
    const flow = mobile(), delta = 600 - flow.filters.height
    flow.filters.height += delta; flow.toolbar.height += delta; flow.search.y += delta; flow.panel.y += delta
    expect(() => assertLibraryFlow(flow)).toThrow('filter height')
  })
  it('rejects a search-only displacement hidden by region screenshots', () => {
    const flow = mobile(); flow.search.y += 40
    expect(() => assertLibraryFlow(flow)).toThrow('search immediately follows')
  })
  it('rejects original-button width, line gap and panel-gap regressions', () => {
    const width = mobile(); width.buttons[0].width += 1
    expect(() => assertLibraryFlow(width)).toThrow('filter flex width')
    const gap = mobile(); gap.buttons[3].y += 1
    expect(() => assertLibraryFlow(gap)).toThrow('filter line placement')
    const panel = mobile(); panel.panel.y += 1
    expect(() => assertLibraryFlow(panel)).toThrow('rows immediately follow')
  })
  it('derives natural button height from original text rather than trusting a changed box', () => {
    const flow = mobile()
    flow.textMetrics = flow.buttons.map(() => ({ advances: [24, 24, 24], lineHeight: 36, paddingX: 14, paddingY: 0, minHeight: 44 }))
    expect(() => assertLibraryFlow(flow)).not.toThrow()
    flow.buttons[0].height = 600
    expect(() => assertLibraryFlow(flow)).toThrow('filter height follows unchanged text')
  })
})

describe('relocated original query rendering contract', () => {
  const reference = [{ label: '全部', markup: '全部', pressed: 'true', active: true, disabled: false, tabIndex: 0,
    style: { 'font-family': 'sans-serif', 'font-size': '14px', 'font-weight': '400', 'line-height': '20px',
      color: 'rgb(20, 30, 40)', 'background-color': 'rgb(240, 242, 255)', 'border-top-width': '1px',
      'border-top-style': 'solid', 'border-top-color': 'rgb(200, 200, 200)', padding: '4px 8px',
      'border-radius': '8px', 'box-shadow': 'none', 'text-shadow': 'none', opacity: '1', transform: 'none' },
    before: { content: 'none', 'background-color': 'transparent' }, after: { content: 'none', color: 'inherit' } }]
  it('accepts unchanged text, all rendering properties, pseudo-elements and state', () => {
    expect(() => assertOriginalLibraryFilters(structuredClone(reference), reference)).not.toThrow()
  })
  it('rejects any changed font, color, border, padding, radius, shadow or rendering property', () => {
    for (const property of Object.keys(reference[0].style)) {
      const changed = structuredClone(reference)
      ;(changed[0].style as Record<string, string>)[property] = 'regressed'
      expect(() => assertOriginalLibraryFilters(changed, reference), property).toThrow('original query rendering')
    }
  })
  it('rejects changed text, child markup, pseudo rendering and interactive states', () => {
    for (const change of [
      { label: '变更' }, { markup: '<span>全部</span>' }, { pressed: 'false' }, { active: false }, { disabled: true }, { tabIndex: -1 },
      { before: { content: 'none', 'background-color': 'red' } }, { after: { content: '"badge"', color: 'inherit' } },
    ]) expect(() => assertOriginalLibraryFilters([{ ...reference[0], ...change }], reference)).toThrow('original query rendering')
  })
})
