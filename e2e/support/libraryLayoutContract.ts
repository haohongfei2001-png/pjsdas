import { strict as assert } from 'node:assert'

export interface Box { x: number; y: number; width: number; height: number }
export interface LibraryFlow {
  toolbar: Box; filters: Box; search: Box; panel: Box
  buttons: Box[]; rowGap: number; columnGap: number; basis: number
  filterMarginBottom: number; toolbarMarginBottom: number; stacked: boolean
  searchTopGap?: number; toolbarBottomGap?: number
  textMetrics?: { advances: number[]; lineHeight: number; paddingX: number; paddingY: number; minHeight: number }[]
}

/** The added query can create a real flex line, never unexplained empty space. */
export function assertLibraryFlow(flow: LibraryFlow) {
  const { toolbar, filters, search, panel, buttons, rowGap, columnGap, basis, stacked } = flow
  const columns = stacked ? Math.floor((filters.width + columnGap) / (basis + columnGap)) : buttons.length
  assert.ok(columns > 0)
  let y = filters.y
  for (let offset = 0; offset < buttons.length; offset += columns) {
    const row = buttons.slice(offset, offset + columns)
    const freeWidth = filters.width - columnGap * (row.length - 1)
    // Blink partitions a flex line at cumulative 1/64 CSS-pixel boundaries.
    // Rounding each item independently loses the middle residual (292/3).
    const boundary = (index: number) => Math.round(freeWidth * index / row.length * 64) / 64
    const widths = row.map((button, index) => stacked ? boundary(index + 1) - boundary(index) : button.width)
    const heights = row.map((button, index) => {
      const text = flow.textMetrics?.[offset + index]
      if (!text) return button.height
      const available = widths[index] - text.paddingX
      let lines = 1, used = 0
      for (const advance of text.advances) {
        if (used + advance > available) { lines++; used = 0 }
        used += advance
      }
      return Math.max(text.minHeight, lines * text.lineHeight + text.paddingY)
    })
    const rowHeight = Math.max(...heights)
    let x = filters.x
    for (const [index, button] of row.entries()) {
      assert.equal(button.height, heights[index], 'filter height follows unchanged text and padding')
      if (stacked) assert.equal(button.width, widths[index], 'original filter flex width')
      assert.equal(button.x, x, 'filter horizontal placement')
      assert.equal(button.y, y + (rowHeight - button.height) / 2, 'filter line placement')
      x += button.width + columnGap
    }
    if (!stacked) assert.equal(x - columnGap, filters.x + filters.width, 'no unexplained filter width')
    y += rowHeight + rowGap
  }
  assert.equal(filters.height, y - rowGap - filters.y, 'filter height must equal actual packed lines')
  assert.equal(filters.x, toolbar.x, 'filter left alignment')
  if (stacked) {
    assert.equal(filters.width, toolbar.width, 'stacked filter width')
    assert.equal(search.x, toolbar.x, 'stacked search left')
    assert.equal(search.width, toolbar.width, 'stacked search width')
    assert.equal(filters.y, toolbar.y, 'stacked filter top')
    assert.equal(search.y, filters.y + filters.height + (flow.searchTopGap ?? flow.filterMarginBottom), 'search immediately follows packed queries')
    assert.equal(toolbar.height, search.y + search.height - toolbar.y + (flow.toolbarBottomGap ?? 0), 'toolbar has no unexplained vertical space')
  } else {
    assert.equal(toolbar.height, Math.max(filters.height, search.height), 'toolbar tightly fits query and search')
    assert.equal(filters.y, toolbar.y + (toolbar.height - filters.height) / 2, 'query vertical alignment')
    assert.equal(search.y, toolbar.y + (toolbar.height - search.height) / 2, 'search vertical alignment')
    assert.equal(search.x + search.width, toolbar.x + toolbar.width, 'search right alignment')
  }
  assert.equal(panel.y, toolbar.y + toolbar.height + flow.toolbarMarginBottom, 'rows immediately follow toolbar')
}

/** The approved extra controls relocate only the original eight query buttons.
 * All collected rendering properties, pseudo-elements, text/markup and state
 * still match the fixed reference exactly. Sizes are checked by the flow oracle. */
export function assertOriginalLibraryFilters(actual: unknown, reference: unknown) {
  assert.deepEqual(actual, reference, 'original query rendering and state remain exact')
}
