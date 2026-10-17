import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { validateSnapshot } from '../src/snapshot.js'
import { assertLibraryFlow, assertOriginalLibraryFilters } from './support/libraryLayoutContract.js'

const phase = process.env.TA_SECONDARY_PHASE === 'before' ? 'before' : 'after'
const evidence = `secondary-ui-${phase}`
const now = '2026-09-23T08:00:00.000Z'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const diagnoseRaster = process.env.TA_SECONDARY_DIAG === '1'
const modalRoots = '.cgr-capture-sheet, .backup-dialog, .event-dock, .prep-graph-dialog, .discovery-inbox-modal, .mcp-proposal-card, .ta-scope-dialog[open]'
const originalJobFilters = ['全部', '待投递', '已投递', '收到笔试', '收到面试', '流程结束', '时间截止', '无截止日期']

test.beforeAll(async ({ browser }, testInfo) => {
  const configuredArguments = testInfo.project.use.launchOptions?.args ?? []
  await mkdir(evidence, { recursive: true })
  await writeFile(`${evidence}/BROWSER_RUNTIME.json`, JSON.stringify({ version: browser.version(), configuredArguments }, null, 2))
})


function fixture(appliedForLayout = false) {
  const snapshot = workspace()
  snapshot.data.opportunities[0]!.company = '示例公司 · 产品与用户研究团队'
  snapshot.data.opportunities[0]!.role = '高级产品策略与体验研究 / Senior Product Research'
  snapshot.data.opportunities[1]!.company = snapshot.data.opportunities[0]!.company
  // The protected layout sample uses already-submitted jobs. Pre-B1 exposes
  // unsubmitted jobs without a deadline as a Schedule category; B1 deliberately
  // removes that business projection, covered by its separate negative tests.
  if (appliedForLayout) snapshot.data.opportunities.forEach(item => {
    item.processStage = 'screening'; item.currentStageLabel = '筛选中'
  })
  // This layout guard compares the same eligible content in both runtimes:
  // two explicitly chosen tasks and the real appointment below. Job/task
  // deadlines used to fabricate four extra reference calendar rows; their
  // removal is a separately asserted B1 business change, not a layout change.
  snapshot.data.actions.forEach(item => { item.plannedDate = '2026-09-23' })
  snapshot.data.timePlanning = { version: 1, defaultDailyMinutes: 480, updatedAt: now }
  snapshot.data.scheduleNodes = [{
    id: 'secondary-node', occurrenceId: 'secondary-occurrence', version: 1,
    opportunityId: 'A-opp-1', kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-09-24', resolutionBasis: 'source_explicit' },
    evidenceRefs: ['synthetic:interview'], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
    createdAt: now, updatedAt: now,
  }]
  snapshot.data.decisionRequests = [{
    id: 'secondary-decision', reason: 'ambiguous_target', state: 'open',
    question: '这次面试安排属于哪个岗位？', affectedObjects: [],
    choices: snapshot.data.opportunities.map(job => ({ id: `opportunity:${job.id}`,
      label: `${job.company} · ${job.role}`, consequence: '仅更新这个岗位，其他记录保持不变。', resolution: { opportunityId: job.id } })),
    evidenceRefs: ['synthetic:decision'], createdAt: now, updatedAt: now,
    payloadBinding: { contractVersion: 1, inputId: 'secondary-input', candidateId: 'fragment:0', statementMode: 'current_intent',
      source: { kind: 'web', sourceId: 'web', sourceRecordId: 'secondary-input', observedAt: now, assertedAt: now, timezone: 'Asia/Shanghai' },
      candidate: { id: 'fragment:0', kind: 'process_event', eventType: 'interview_invite', target: { company: snapshot.data.opportunities[0]!.company }, objectConfidence: 'low', eventConfidence: 'high', evidenceRefs: ['synthetic:decision'], sourceVersionRefs: [] } },
  }]
  snapshot.data.discoveryInbox = [{
    id: 'secondary-discovery', candidateOpportunityId: 'secondary-candidate', company: '合成发现公司',
    role: '产品研究与体验设计 / Product Research', roleType: 'core',
    sourceUrl: 'https://example.test/jobs/synthetic', sourceTitle: 'Synthetic source',
    rationale: '仅用于预览界面验证，不是真实招聘信息。', opportunityValue: 75, fitScore: 80,
    fitConfidence: 'medium', opportunityValueConfidence: 'medium', status: 'new',
    discoveredAt: now, createdAt: now, updatedAt: now,
  }]
  validateSnapshot(snapshot)
  return snapshot
}

async function seed(page: Page, appliedForLayout = false, snapshot = fixture(appliedForLayout)) {
  await page.clock.setFixedTime(new Date(now))
  await seedSession(page.context())
  const mutations: string[] = []
  await page.route(`${MOCK_TARGET_AUTH_ORIGIN}/**`, route => route.abort())
  await page.route(BACKEND + '/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path === '/api/access' && request.postDataJSON().action === 'read') return cors(route, {
      authenticated: true, allowed: true, mode: 'allowlist', role: 'owner', email: 'synthetic@example.test',
    })
    if (path === '/api/automation-settings' && request.postDataJSON().action === 'read') return cors(route, {
      googleEmail: 'synthetic@example.test', gmailScopeGranted: true, gmailEnabled: true,
      gmailHistoryIdPresent: true, gmailLastCheckedAt: now, gmailLastSuccessAt: now,
      gmailLastError: null, discoveryEnabled: false, discoveryLastCheckedAt: null,
      discoveryLastSuccessAt: null, discoveryLastError: null,
    })
    if (path === '/api/workspace') {
      const body = request.postDataJSON()
      if (body.action === 'read') return cors(route, { workspaceId: 'ws-a', revision: 91, workspaceVersion: 'txn:91', schemaVersion: snapshot.version, snapshot })
      mutations.push(body.action); return cors(route, { code: 'UNEXPECTED_WRITE' }, 409)
    }
    return cors(route, { code: 'NOT_FOUND' }, 404)
  })
  return mutations
}

async function capture(page: Page, label: string, width: number, scale = 100, protectMain = false, scrollRoot?: string) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; window.scrollTo(0, 0) }, scale)
  await page.evaluate(() => document.fonts.ready)
  if (scrollRoot) await page.locator(scrollRoot).evaluate(element => { element.scrollTop = element.scrollHeight })
  const name = `${label}-${width}-${scale}.png`
  await mkdir(evidence, { recursive: true })
  const overlay = await page.locator('.cgr-capture-backdrop, .backup-backdrop, .event-dock-backdrop, .prep-graph-backdrop, .discovery-inbox-modal-backdrop, .mcp-proposal-backdrop, .ta-scope-dialog[open]').count()
  const bytes = await page.screenshot({ path: `${evidence}/${name}`, fullPage: overlay === 0, animations: 'disabled', caret: 'hide' })
  if (diagnoseRaster && protectMain) {
    const hashes = [digest(bytes)]
    for (let index = 1; index <= 2; index++) hashes.push(digest(await page.screenshot({
      path: `${evidence}/${name}.repeat-${index}.png`, fullPage: overlay === 0, animations: 'disabled', caret: 'hide',
    })))
    await writeFile(`${evidence}/${name}.repeat.json`, JSON.stringify({ hashes }, null, 2))
    await saveRenderContract(page, `${name}.dom`)
  }
  if (protectMain && phase === 'after') {
    const baseline = await readFile(`secondary-ui-before/${name}`)
    expect.soft(digest(bytes), `${label}: all main pixels must match the approved pre-B1 reference dbad720`).toBe(digest(baseline))
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const overflowNodes = overflow > 1 ? await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')]
    .filter(element => element.getClientRects().length && (element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1))
    .slice(0, 20).map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right,
      left: element.getBoundingClientRect().left, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))) : []
  const modalBounds = await page.locator(modalRoots).evaluateAll(elements => elements.map(element => ({
    className: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
  })))
  const metric = { label, width, scale, overflow, overflowNodes, modalBounds, sha256: digest(bytes), protectedMain: protectMain }
  console.log('SECONDARY_UI:' + JSON.stringify(metric))
  await writeFile(`${evidence}/${name}.json`, JSON.stringify(metric, null, 2))
  if (phase === 'after') {
    for (const bounds of modalBounds) {
      expect(bounds.left, `${name}: dialog left edge`).toBeGreaterThanOrEqual(0)
      expect(bounds.right, `${name}: dialog right edge`).toBeLessThanOrEqual(width + 1)
      expect(bounds.scrollWidth - bounds.clientWidth, `${name}: no hidden horizontal dialog content`).toBeLessThanOrEqual(1)
    }
    if (overlay && overflow > 1) {
      // The frozen Discovery inbox behind the dialog already overflows at
      // 320px/200% (its header/list reach442px). Do not change the owner's
      // protected background to conceal it: require no regression there,
      // while the active dialog still satisfies the strict bounds above.
      const baseline = JSON.parse(await readFile(`secondary-ui-before/${name}.json`, 'utf8'))
      expect(modalBounds.length).toBeGreaterThan(0)
      expect(overflow, `${name}: unchanged background overflow`).toBeLessThanOrEqual(baseline.overflow)
    } else expect(overflow, `${name}: no horizontal overflow`).toBeLessThanOrEqual(1)
  }
}

// Diagnostic evidence only: native screenshots and DOM reads. No retry selects
// a passing image, no styles/pixels are changed, and the first capture is gated.
async function saveRenderContract(page: Page, name: string, selector = '.cgr-app-shell') {
  const dom = await page.locator(selector).evaluate(root => ({ state: {
    scrollX, scrollY, innerWidth, innerHeight, devicePixelRatio, readyState: document.readyState,
    fonts: { status: document.fonts.status, faces: [...document.fonts].map(font => ({ family: font.family, status: font.status, style: font.style, weight: font.weight })) },
    activeElement: document.activeElement?.outerHTML,
    animations: document.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime, timing: animation.effect?.getComputedTiming() })),
  }, roots: [document.documentElement, document.body, document.getElementById('root')!].map(element => {
    const box = element.getBoundingClientRect(), css = getComputedStyle(element)
    return { tag: element.tagName, attributes: Object.fromEntries([...element.attributes].map(attr => [attr.name, attr.value])),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      style: Object.fromEntries([...css].map(key => [key, css.getPropertyValue(key)])),
      pseudo: ['::before', '::after'].map(selector => { const value = getComputedStyle(element, selector); return Object.fromEntries([...value].map(key => [key, value.getPropertyValue(key)])) }) }
  }), styleSheets: [...document.styleSheets].map(sheet => ({ href: sheet.href, disabled: sheet.disabled,
    media: sheet.media.mediaText, rules: [...sheet.cssRules].map(rule => rule.cssText) })),
  elements: [root, ...root.querySelectorAll('*')].map(element => {
    const box = element.getBoundingClientRect(), css = getComputedStyle(element)
    return { tag: element.tagName, className: element.className, attributes: Object.fromEntries([...element.attributes].map(attr => [attr.name, attr.value])), text: element.childElementCount ? undefined : element.textContent,
      box: { x: box.x, y: box.y + scrollY, width: box.width, height: box.height },
      style: Object.fromEntries([...css].map(key => [key, css.getPropertyValue(key)])) }
  }) }))
  await writeFile(`${evidence}/${name}.json`, JSON.stringify(dom, null, 2))
}

// B3 permits the new scope block, ninth query and retired Inbox link only.
// Keep the unmodified full-page evidence, then compare real DOM regions without
// masking, repainting, moving elements, changing the baseline, or pixel tolerance.
async function protectLibrary(page: Page, width: number, scale: number) {
  await capture(page, 'MAIN_JOBS', width, scale)
  const filters = page.locator('.tsui-library-filters button')
  await expect(filters).toHaveCount(phase === 'before' ? 8 : 9)
  expect((await filters.allTextContents()).filter(label => !/^新发现 /.test(label))).toEqual(originalJobFilters)
  await expect(page.locator('.ta-search-scope')).toHaveCount(phase === 'before' ? 0 : 1)
  if (phase === 'after') await expect(page.locator('[data-job-filter="new"]')).toHaveText('新发现 0')
  const geometry = await page.evaluate(labels => {
    const rect = (selector: string | Element) => {
      const box = (typeof selector === 'string' ? document.querySelector(selector)! : selector).getBoundingClientRect()
      return { x: box.x, y: box.y + scrollY, width: box.width, height: box.height }
    }
    const style = (element: Element, pseudo?: string) => {
      const css = getComputedStyle(element, pseudo)
      // Computed sizes/origins follow the independently checked flex layout.
      // Every other computed property stays exact, including min-height,
      // margins, display, positioning, padding and pseudo-element contents.
      const dimensions = ['width', 'height', 'inline-size', 'block-size', 'perspective-origin', 'transform-origin']
      return Object.fromEntries([...css].filter(key => pseudo || !dimensions.includes(key)).map(key => [key, css.getPropertyValue(key)]))
    }
    const oldFilters = labels.map(label => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.tsui-library-filters button')].find(item => item.textContent === label)!
      return { label, markup: button.innerHTML, style: style(button), pressed: button.getAttribute('aria-pressed'),
        active: button.classList.contains('active'), disabled: button.disabled, tabIndex: button.tabIndex, before: style(button, '::before'), after: style(button, '::after') }
    })
    const filterBox = document.querySelector('.tsui-library-filters')!, toolbar = document.querySelector('.tsui-library-toolbar')!
    const filterCss = getComputedStyle(filterBox), toolbarCss = getComputedStyle(toolbar)
    const buttons = [...filterBox.querySelectorAll('button')]
    const canvas = document.createElement('canvas').getContext('2d')!
    const textMetrics = buttons.map(button => {
      const css = getComputedStyle(button); canvas.font = css.font
      return { advances: [...button.textContent!].map(character => canvas.measureText(character).width),
        lineHeight: parseFloat(css.lineHeight), paddingX: parseFloat(css.paddingLeft) + parseFloat(css.paddingRight),
        paddingY: parseFloat(css.paddingTop) + parseFloat(css.paddingBottom), minHeight: parseFloat(css.minHeight) }
    })
    const scope = document.querySelector('.ta-search-scope')
    const scopeExtent = scope ? scope.getBoundingClientRect().height + parseFloat(getComputedStyle(scope).marginBottom) : 0
    return { heading: rect('.tsui-library-heading'), toolbar: rect('.tsui-library-toolbar'), search: rect('.tsui-library-toolbar input'), panel: rect('.tsui-library-panel'),
      total: rect('.tsui-library-total'), scopeExtent, oldFilters, searchStyle: style(document.querySelector('.tsui-library-toolbar input')!),
      filterStyle: style(filterBox), toolbarStyle: style(toolbar),
      oldButtonBoxes: labels.map(label => rect(buttons.find(button => button.textContent === label)!)),
      flow: { toolbar: rect(toolbar), filters: rect(filterBox), search: rect('.tsui-library-toolbar input'), panel: rect('.tsui-library-panel'),
        buttons: buttons.map(rect), textMetrics, rowGap: parseFloat(filterCss.rowGap) || 0, columnGap: parseFloat(filterCss.columnGap) || 0,
        basis: parseFloat(getComputedStyle(buttons[0]).flexBasis), stacked: toolbarCss.display !== 'flex' || toolbarCss.flexDirection === 'column',
        filterMarginBottom: parseFloat(filterCss.marginBottom), toolbarMarginBottom: parseFloat(toolbarCss.marginBottom) } }
  }, originalJobFilters)
  const metricName = `LIBRARY_CONTRACT-${width}-${scale}.json`
  await writeFile(`${evidence}/${metricName}`, JSON.stringify(geometry, null, 2))
  const before = phase === 'after' ? JSON.parse(await readFile(`secondary-ui-before/${metricName}`, 'utf8')) : undefined
  const referenceFlow = before?.flow ?? geometry.flow
  // The unchanged inline search input can have native line-box ascent/descent
  // space at 200% text. Preserve those exact reference gaps, not candidate gaps.
  assertLibraryFlow({ ...geometry.flow,
    searchTopGap: referenceFlow.search.y - referenceFlow.filters.y - referenceFlow.filters.height,
    toolbarBottomGap: referenceFlow.toolbar.y + referenceFlow.toolbar.height - referenceFlow.search.y - referenceFlow.search.height })
  if (phase === 'after') {
    expect(geometry.heading).toEqual(before.heading)
    assertOriginalLibraryFilters(geometry.oldFilters, before.oldFilters)
    expect(geometry.searchStyle).toEqual(before.searchStyle)
    expect(geometry.filterStyle).toEqual(before.filterStyle)
    expect(geometry.toolbarStyle).toEqual(before.toolbarStyle)
    for (let index = 0; index < originalJobFilters.length; index++) {
      if (!geometry.flow.stacked) expect(geometry.oldButtonBoxes[index].width, 'original desktop filter width').toBe(before.oldButtonBoxes[index].width)
    }
    expect(geometry.toolbar.y - before.toolbar.y, 'only the scope block displaces the toolbar').toBe(geometry.scopeExtent)
    expect(geometry.panel.y - before.panel.y, 'only scope height and query wrapping displace rows')
      .toBe(geometry.scopeExtent + geometry.toolbar.height - before.toolbar.height)
    expect(geometry.total.y - geometry.panel.y - geometry.panel.height).toBe(before.total.y - before.panel.y - before.panel.height)
    for (const region of ['search', 'panel', 'total'] as const) {
      expect({ ...geometry[region], y: 0 }).toEqual({ ...before[region], y: 0 })
    }
  }
  for (let index = 0; index < originalJobFilters.length; index++) {
    const name = `LIBRARY_FILTER_${index}-${width}-${scale}.png`
    // Preserve raw button evidence. The approved added block/query relocates
    // every original button: Skia corner coverage and fractional clip neighbors
    // can differ even at equal box sizes. Do not claim pixel identity, repaint,
    // crop edges or add tolerance. Exact DOM styles/state and independently
    // derived geometry above guard these eight relocated controls instead.
    await page.locator('.tsui-library-filters').getByRole('button', { name: originalJobFilters[index], exact: true })
      .screenshot({ path: `${evidence}/${name}`, animations: 'disabled', caret: 'hide' })
  }
  for (const [label, selector] of [['HEADING', '.tsui-library-heading'], ['SEARCH', '.tsui-library-toolbar input'], ['ROWS', '.tsui-library-panel'], ['TOTAL', '.tsui-library-total']] as const) {
    const name = `LIBRARY_${label}-${width}-${scale}.png`
    const bytes = await page.locator(selector).screenshot({ path: `${evidence}/${name}`, animations: 'disabled', caret: 'hide' })
    if (diagnoseRaster) {
      const hashes = [digest(bytes)]
      for (let index = 1; index <= 2; index++) hashes.push(digest(await page.locator(selector).screenshot({
        path: `${evidence}/${name}.repeat-${index}.png`, animations: 'disabled', caret: 'hide',
      })))
      await writeFile(`${evidence}/${name}.repeat.json`, JSON.stringify({ hashes }, null, 2))
      await saveRenderContract(page, `${name}.dom`, selector)
    }
    if (phase === 'after') {
      const baseline = await readFile(`secondary-ui-before/${name}`)
      expect.soft(digest(bytes), `${name}: unchanged original Library region`).toBe(digest(baseline))
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0))
}

for (const width of [1440, 390, 320]) test(`original eight Library queries, deadline order and 40-row paging at ${width}`, async ({ page }) => {
  const snapshot = fixture()
  snapshot.data.actions = []; snapshot.data.scheduleNodes = []; snapshot.data.decisionRequests = []
  snapshot.data.opportunities = Array.from({ length: 45 }, (_, index) => ({
    ...snapshot.data.opportunities[0]!, id: `page-${String(index).padStart(3, '0')}`, company: `分页公司 ${index}`, role: '产品经理',
    processStage: (['not_applied', 'screening', 'written_test', 'interview', 'offer', 'not_applied'] as const)[index] ?? 'not_applied',
    ...([0, 5, 6].includes(index) ? { deadline: index === 0 ? '2026-09-25' : index === 6 ? '2026-09-24' : '2026-09-21', deadlinePrecision: 'date' as const } : {}),
  }))
  validateSnapshot(snapshot)
  const mutations = await seed(page, false, snapshot)
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/pjsdas/library')
  const rows = page.locator('.tsui-job-row'), filters = page.locator('.tsui-library-filters')
  await expect(rows).toHaveCount(40)
  await expect(rows.nth(0)).toHaveAttribute('data-opportunity-id', 'page-006')
  await expect(rows.nth(1)).toHaveAttribute('data-opportunity-id', 'page-000')
  await expect(page.locator('.tsui-library-more')).toContainText('40/45')
  await page.locator('.tsui-library-more').click()
  await expect(rows).toHaveCount(45)
  const ids = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-opportunity-id')))
  expect(new Set(ids).size).toBe(45)
  expect(ids.at(-1), 'expired jobs retain the original ended-last grouping').toBe('page-005')
  await expect(page.locator('.tsui-library-more')).toHaveCount(0)
  for (const [label, count] of originalJobFilters.map((label, index) => [label, [40, 2, 1, 1, 1, 1, 1, 38][index]] as const)) {
    await filters.getByRole('button', { name: label, exact: true }).click()
    await expect(rows).toHaveCount(count)
    await expect(filters.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true')
  }
  await filters.getByRole('button', { name: '全部', exact: true }).click()
  const search = page.getByRole('searchbox', { name: '搜索公司或岗位', exact: true })
  await search.fill('分页公司 44')
  await expect(rows).toHaveCount(1)
  await expect(rows).toHaveAttribute('data-opportunity-id', 'page-044')
  await search.fill('')
  await expect(rows).toHaveCount(40)
  if (phase === 'after') {
    await page.locator('[data-job-filter="new"]').click()
    await expect(rows).toHaveCount(0)
    await expect(page.locator('[data-job-filter="new"]')).toHaveText('新发现 0')
  }
  expect(mutations).toEqual([])
})

for (const width of [1440, 390, 320]) test(`main pixels stay fixed before and after secondary navigation at ${width}`, async ({ page }) => {
  const mutations = await seed(page, true)
  const scale = width === 320 ? 200 : 100
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-row[data-action-id]')).toHaveCount(2)
  await expect(page.locator('.tsui-task-row:not([data-action-id])')).toHaveCount(1)
  await expect(page.locator('.tsui-node-panel .tsui-node-row')).toHaveCount(1)
  await capture(page, 'MAIN_TODAY', width, scale, true)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '岗位库', exact: true }).click()
  await expect(page.locator('.tsui-job-open')).toHaveCount(2)
  await protectLibrary(page, width, scale)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '日程', exact: true }).click()
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(1)
  await capture(page, 'MAIN_SCHEDULE', width, scale, true)
  await page.locator('.tsui-topbar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible()
  await capture(page, 'SETTINGS', width, scale)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '今天', exact: true }).click()
  await expect(page.locator('.tsui-task-row')).not.toHaveCount(0)
  await capture(page, 'MAIN_AFTER_SETTINGS', width, scale, true)
  await page.locator('.tsui-tell-button').click()
  await expect(page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' })).toBeFocused()
  if (phase === 'after') {
    const ring = await page.locator('.cgr-capture-input').evaluate(element => ({
      color: getComputedStyle(element).outlineColor, width: getComputedStyle(element).outlineWidth,
    }))
    expect(ring).toEqual({ color: 'rgb(49, 94, 197)', width: '3px' })
  }
  await capture(page, 'CAPTURE', width, scale)
  await page.getByRole('textbox', { name: '要告诉 TodayAction 的内容' }).fill('例如：明天下午准备面试。')
  await expect(page.locator('.cgr-understanding')).toBeVisible()
  await capture(page, 'CAPTURE_PREVIEW', width, scale)
  await page.keyboard.press('Escape')
  await expect(page.locator('.tsui-tell-button')).toBeFocused()
  await capture(page, 'MAIN_AFTER_CAPTURE', width, scale, true)
  expect(mutations).toEqual([])
})

for (const width of [1440, 390, 320]) test(`details and settings retain readable complete content at ${width}`, async ({ page }) => {
  const mutations = await seed(page)
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.goto('/pjsdas/library/A-opp-1')
  await expect(page.locator('.job-detail-page h1')).toContainText('Senior Product Research')
  await capture(page, 'JOB_DETAIL', width)
  await page.getByRole('button', { name: '告诉 TodayAction', exact: true }).click()
  await expect(page.locator('.cgr-capture-context')).toContainText('示例公司')
  await capture(page, 'CONTEXT_CAPTURE', width, width === 320 ? 200 : 100)
  if (width === 320) {
    await capture(page, 'CONTEXT_CAPTURE_BOTTOM', width, 200, false, '.cgr-capture-sheet')
    const footerButtons = page.locator('.cgr-capture-footer button')
    await expect(footerButtons).toHaveCount(phase === 'after' ? 2 : 1)
    for (const button of await footerButtons.all()) await expect(button).toBeInViewport()
    if (phase === 'after') expect(await page.locator('.cgr-capture-mode').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(25)
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.job-detail-capture')).toBeFocused()
  await page.goto('/pjsdas/decisions/secondary-decision?from=A-opp-1')
  await expect(page.locator('.ultimate-decision-card')).toHaveCount(1)
  await capture(page, 'DECISION_DETAIL', width, width === 320 ? 200 : 100)
  await page.goto('/pjsdas/decisions/missing')
  await expect(page.locator('.ultimate-quiet-state')).toBeVisible()
  await capture(page, 'DECISION_EMPTY', width)
  await page.goto('/pjsdas/library/missing')
  await expect(page.locator('.cgr-missing-opportunity')).toBeVisible()
  await capture(page, 'JOB_MISSING', width)
  await page.goto('/pjsdas/schedule')
  await expect(page.locator('.tsui-schedule-row')).not.toHaveCount(0)
  await page.locator('.tsui-schedule-row').first().click()
  await expect(page.locator('.tsui-schedule-detail')).toBeVisible()
  await capture(page, 'EVENT_DETAIL', width, width === 320 ? 200 : 100)
  await page.getByRole('button', { name: '关闭详情' }).click()
  await expect(page.locator('.tsui-schedule-detail')).toHaveCount(0)
  await page.goto('/pjsdas/settings')
  await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible()
  await capture(page, 'SETTINGS_OVERVIEW', width, width === 320 ? 200 : 100)
  await expect(page.locator('.settings-group > summary').filter({ hasText: '可用时间' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存时段', exact: true })).toHaveCount(0)
  await capture(page, 'SETTINGS_PLANNING_RETIRED', width, width === 320 ? 200 : 100)
  if (phase === 'before') {
    await page.locator('.settings-group > summary').filter({ hasText: '岗位发现偏好' }).click()
    await expect(page.locator('.discovery-profile-grid')).toBeVisible()
    await capture(page, 'SETTINGS_DISCOVERY', width, width === 320 ? 200 : 100)
  } else {
    await expect(page.locator('.settings-group > summary').filter({ hasText: '岗位发现偏好' })).toHaveCount(0)
    await expect(page.locator('.discovery-profile-grid')).toHaveCount(0)
    await capture(page, 'SETTINGS_DISCOVERY_RETIRED', width, width === 320 ? 200 : 100)
  }
  if (phase === 'after') {
    await expect(page.locator('.settings-group > summary').filter({ hasText: '决策规则' })).toHaveCount(0)
    await expect(page.locator('.rules-grid')).toHaveCount(0)
  }
  await capture(page, 'SETTINGS_RULES_RETIRED', width, width === 320 ? 200 : 100)
  await page.locator('.settings-group > summary').filter({ hasText: '数据与恢复' }).click()
  await page.locator('.backup-dock-trigger').click()
  await expect(page.locator('.backup-dialog')).toBeVisible()
  await capture(page, 'BACKUP_DETAIL', width, width === 320 ? 200 : 100)
  if (width === 320) await capture(page, 'BACKUP_DETAIL_BOTTOM', width, 200, false, '.backup-dialog')
  await page.locator('.backup-close').click()
  await page.locator('.event-dock-trigger').click()
  await expect(page.locator('.event-dock')).toBeVisible()
  await capture(page, 'PROCESS_DETAIL', width, width === 320 ? 200 : 100)
  if (width === 320) await capture(page, 'PROCESS_DETAIL_BOTTOM', width, 200, false, '.event-dock')
  await page.locator('.event-close').click()
  expect(mutations).toEqual([])
})

// A minimal real-route replay isolates prior navigation/compositor history.
// It is additional evidence: it never replaces a failing original route gate.
for (const [width, route, nav] of [[1440, 'schedule', '日程'], [390, 'today', '今天']] as const) {
  test(`direct-route raster replay ${route} at ${width}`, async ({ page }) => {
    const mutations = await seed(page, true)
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await page.goto(`/pjsdas/${route}`)
    await expect(page.locator(route === 'schedule' ? '.tsui-schedule-row' : '.tsui-task-row[data-action-id]')).toHaveCount(route === 'schedule' ? 1 : 2)
    await page.locator('.tsui-primary-nav').getByRole('button', { name: nav, exact: true }).click()
    await capture(page, `DIRECT_${route.toUpperCase()}`, width, 100, true)
    expect(mutations).toEqual([])
  })
}

for (const width of [1440, 390, 320]) test(`secondary previews and unknown-save state stay intact at ${width}`, async ({ page }) => {
  const mutations = await seed(page)
  const scale = width === 320 ? 200 : 100
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.goto('/pjsdas/library')
  await expect(page.locator('.tsui-job-open')).toHaveCount(2)
  await page.locator('.tsui-library-secondary button').filter({ hasText: '准备' }).click()
  await page.locator('.prep-graph-dock-trigger').click()
  await expect(page.locator('.prep-graph-summary')).toBeVisible()
  await capture(page, 'PREPARATION_DETAIL', width, scale)
  await page.locator('.prep-graph-close').click()
  await page.locator('.tsui-library-back').click()
  if (phase === 'before') {
    await page.locator('.tsui-library-secondary button').filter({ hasText: '发现箱' }).click()
    await page.getByRole('button', { name: '加入 Opportunities', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '加入机会池预览' })).toBeVisible()
    await capture(page, 'DISCOVERY_DETAIL', width, scale)
    await page.locator('.discovery-inbox-modal-actions').getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.discovery-inbox-modal')).toHaveCount(0)
  } else {
    await expect(page.locator('.tsui-library-secondary button').filter({ hasText: '发现箱' })).toHaveCount(0)
    await page.getByRole('button', { name: '搜索范围', exact: true }).click()
    const scope = page.getByRole('dialog', { name: '每天帮你找新岗位' })
    await expect(scope).toBeVisible()
    await expect(scope.getByRole('button', { name: '开启每日发现（待预算）', exact: true })).toBeDisabled()
    await capture(page, 'SEARCH_SCOPE', width, scale)
    await scope.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(scope).not.toBeVisible()
    await expect(page.getByRole('button', { name: '搜索范围', exact: true })).toBeFocused()
  }
  await page.goto('/pjsdas/today#pjsdas-proposal=synthetic-invalid-signature')
  await expect(page.locator('.mcp-proposal-card').getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  await capture(page, 'PROPOSAL_REJECTED', width, scale)
  await page.locator('.mcp-proposal-card').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.mcp-proposal-card')).toHaveCount(0)
  await page.goto('/pjsdas/today')
  const commandIds: string[] = []
  await page.route(BACKEND + '/api/workspace', route => {
    if (route.request().method() === 'OPTIONS') return route.fallback()
    const body = route.request().postDataJSON()
    if (body.action === 'command') { commandIds.push(body.commandId); return route.abort() }
    if (body.action === 'receipt') return route.abort()
    return route.fallback()
  })
  await page.locator('.tsui-tell-button').click()
  await page.locator('.cgr-capture-input').fill('事项：整理面试材料')
  await page.getByRole('button', { name: '确认并保存', exact: true }).click()
  await expect(page.locator('.cgr-capture-error')).toContainText('保存结果暂时未知')
  await expect(page.locator('.cgr-capture-input')).toBeDisabled()
  await capture(page, 'CAPTURE_UNKNOWN', width, scale)
  await capture(page, 'CAPTURE_UNKNOWN_BOTTOM', width, scale, false, '.cgr-capture-sheet')
  await expect(page.getByRole('button', { name: '确认保存状态', exact: true })).toBeInViewport()
  expect(commandIds).toHaveLength(1)
  expect(mutations).toEqual([])
})
