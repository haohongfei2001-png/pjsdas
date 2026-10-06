import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { validateSnapshot } from '../src/snapshot.js'

const phase = process.env.TA_SECONDARY_PHASE === 'before' ? 'before' : 'after'
const evidence = `secondary-ui-${phase}`
const now = '2026-09-23T08:00:00.000Z'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const modalRoots = '.cgr-capture-sheet, .backup-dialog, .event-dock, .prep-graph-dialog, .discovery-inbox-modal, .mcp-proposal-card'

function fixture() {
  const snapshot = workspace()
  snapshot.data.opportunities[0]!.company = '示例公司 · 产品与用户研究团队'
  snapshot.data.opportunities[0]!.role = '高级产品策略与体验研究 / Senior Product Research'
  snapshot.data.opportunities[1]!.company = snapshot.data.opportunities[0]!.company
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

async function seed(page: Page) {
  await page.clock.setFixedTime(new Date(now))
  await seedSession(page.context())
  const snapshot = fixture()
  const mutations: string[] = []
  await page.route(/https:\/\/[^/]+\.supabase\.co\//, route => route.abort())
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

// The owner explicitly replaced this one labelled header button with a + icon.
// Keep the unmasked evidence and compare every other pixel against the frozen reference.
async function compareOutsideCaptureButton(page: Page, before: Buffer, after: Buffer, boxes: Array<{ x: number; y: number; width: number; height: number; headerBottom: number }>, viewportWidth: number) {
  for (const box of boxes) {
    expect(box.y - 6).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height + 6).toBeLessThanOrEqual(box.headerBottom)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1)
    expect(box.width).toBeLessThanOrEqual(Math.min(viewportWidth, 400))
    expect(box.height).toBeLessThanOrEqual(140)
  }
  expect(boxes.reduce((sum, box) => sum + (box.width + 12) * (box.height + 12), 0)).toBeLessThanOrEqual(55_000)
  return page.evaluate(async ({ images, boxes }) => {
    const loaded = await Promise.all(images.map(async encoded => {
      const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode(); return image
    }))
    const hashes: string[] = []
    for (const image of loaded) {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
      context.fillStyle = '#ff00ff'
      for (const box of boxes) context.fillRect(Math.floor(box.x) - 6, Math.floor(box.y) - 6, Math.ceil(box.width) + 12, Math.ceil(box.height) + 12)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const hash = await crypto.subtle.digest('SHA-256', pixels)
      hashes.push(`${canvas.width}x${canvas.height}:` + [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''))
    }
    return hashes
  }, { images: [before.toString('base64'), after.toString('base64')], boxes })
}

async function captureLayout(page: Page) {
  const selectors = ['.tsui-topbar', '.tsui-top-actions', '.tsui-primary-nav', '.cgr-main', '.tsui-settings-button', '.tsui-topbar .tsui-tell-button']
  const boxes = await Promise.all(selectors.map(selector => page.locator(selector).boundingBox()))
  for (const box of boxes) expect(box).not.toBeNull()
  const [header, actions, nav, main, gear, button] = boxes
  return { header: header!, actions: actions!, nav: nav!, main: main!, gear: gear!, button: button! }
}

async function settleHeaderLayout(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect.poll(() => page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.tsui-topbar')!
    const shell = header.closest<HTMLElement>('.cgr-app-shell')!
    return Math.abs(Number.parseFloat(getComputedStyle(shell).getPropertyValue('--ta-header-height')) - header.getBoundingClientRect().height)
  })).toBeLessThanOrEqual(1)
}

async function protectedMainPixels(page: Page, name: string, raw: Buffer, rawLayout: Awaited<ReturnType<typeof captureLayout>>, width: number) {
  const baseline = await readFile(`secondary-ui-before/${name}`)
  const reference = JSON.parse(await readFile(`secondary-ui-before/${name}.json`, 'utf8'))
  const prior = reference.rawLayout as typeof rawLayout
  expect(prior).toBeTruthy()
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)
  near(rawLayout.actions.height, 44)
  for (const key of ['x', 'width', 'height'] as const) near(rawLayout.gear[key], prior.gear[key])
  for (const key of ['x', 'width'] as const) near(rawLayout.main[key], prior.main[key])
  const delta = prior.actions.height - rawLayout.actions.height
  expect(delta).toBeGreaterThanOrEqual(0)
  near(prior.header.height - rawLayout.header.height, delta)
  near(prior.main.y - rawLayout.main.y, delta)
  near(prior.nav.y - rawLayout.nav.y, delta)
  const normalize = width <= 700 && prior.actions.height > 44
  if (!normalize) near(delta, 0)
  const original = await page.locator('.tsui-top-actions').evaluate(element => ({
    value: (element as HTMLElement).style.getPropertyValue('min-height'),
    priority: (element as HTMLElement).style.getPropertyPriority('min-height'),
  }))
  let compared = raw, comparedLayout = rawLayout
  try {
    if (normalize) {
      // Only the approved button's shorter row is normalized. Raw UI evidence
      // remains untouched; every other pixel must still match the frozen page.
      await page.locator('.tsui-top-actions').evaluate((element, height) => {
        (element as HTMLElement).style.setProperty('min-height', height + 'px')
      }, prior.actions.height)
      await settleHeaderLayout(page)
      comparedLayout = await captureLayout(page)
      near(comparedLayout.header.height, prior.header.height)
      near(comparedLayout.main.y, prior.main.y)
      compared = await page.screenshot({ path: `${evidence}/${name.replace('.png', '-normalized.png')}`, fullPage: true, animations: 'disabled', caret: 'hide' })
      await writeFile(`${evidence}/${name}.normalized-layout.json`, JSON.stringify({ baseline: prior, raw: rawLayout, normalized: comparedLayout }, null, 2))
    }
    const hashes = await compareOutsideCaptureButton(page, baseline, compared, [
      { ...prior.button, headerBottom: prior.header.y + prior.header.height },
      { ...comparedLayout.button, headerBottom: comparedLayout.header.y + comparedLayout.header.height },
    ], width)
    expect(hashes[1], `${name}: exact remaining pixels after only approved button/row normalization`).toBe(hashes[0])
  } finally {
    if (normalize) {
      await page.locator('.tsui-top-actions').evaluate((element, original) => {
        const style = (element as HTMLElement).style
        if (original.value) style.setProperty('min-height', original.value, original.priority)
        else style.removeProperty('min-height')
      }, original)
      await settleHeaderLayout(page)
      const restored = await captureLayout(page)
      for (const name of Object.keys(rawLayout) as Array<keyof typeof rawLayout>) {
        for (const key of ['x', 'y', 'width', 'height'] as const) near(restored[name][key], rawLayout[name][key])
      }
    }
  }
}

async function capture(page: Page, label: string, width: number, scale = 100, protectMain = false, scrollRoot?: string) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; window.scrollTo(0, 0) }, scale)
  await page.evaluate(() => document.fonts.ready)
  if (scrollRoot) await page.locator(scrollRoot).evaluate(element => { element.scrollTop = element.scrollHeight })
  const name = `${label}-${width}-${scale}.png`
  await mkdir(evidence, { recursive: true })
  const overlay = await page.locator('.cgr-capture-backdrop, .backup-backdrop, .event-dock-backdrop, .prep-graph-backdrop, .discovery-inbox-modal-backdrop, .mcp-proposal-backdrop').count()
  const bytes = await page.screenshot({ path: `${evidence}/${name}`, fullPage: overlay === 0, animations: 'disabled', caret: 'hide' })
  const rawLayout = await captureLayout(page)
  const captureAffordance = rawLayout.button
  const captureHeaderBottom = rawLayout.header.y + rawLayout.header.height
  await writeFile(`${evidence}/${name}.raw-layout.json`, JSON.stringify(rawLayout, null, 2))
  if (protectMain && phase === 'after') await protectedMainPixels(page, name, bytes, rawLayout, width)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const overflowNodes = overflow > 1 ? await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')]
    .filter(element => element.getClientRects().length && (element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1))
    .slice(0, 20).map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right,
      left: element.getBoundingClientRect().left, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))) : []
  const modalBounds = await page.locator(modalRoots).evaluateAll(elements => elements.map(element => ({
    className: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
  })))
  const metric = { label, width, scale, captureAffordance, captureHeaderBottom, rawLayout, overflow, overflowNodes, modalBounds, sha256: digest(bytes), protectedMain: protectMain }
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

for (const width of [1440, 390, 320]) test(`main pixels stay fixed before and after secondary navigation at ${width}`, async ({ page }) => {
  const mutations = await seed(page)
  const scale = width === 320 ? 200 : 100
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-row')).not.toHaveCount(0)
  await capture(page, 'MAIN_TODAY', width, scale, true)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '岗位库', exact: true }).click()
  await expect(page.locator('.tsui-job-open')).toHaveCount(2)
  await capture(page, 'MAIN_JOBS', width, scale, true)
  await page.locator('.tsui-primary-nav').getByRole('button', { name: '日程', exact: true }).click()
  await expect(page.locator('.tsui-schedule-row')).not.toHaveCount(0)
  await capture(page, 'MAIN_SCHEDULE', width, scale, true)
  await page.locator('.tsui-topbar').getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '账号与跨设备数据', exact: true })).toBeVisible()
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
    await expect(page.locator('.cgr-capture-footer button')).toBeInViewport()
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
  await expect(page.getByRole('heading', { name: '账号与跨设备数据', exact: true })).toBeVisible()
  await capture(page, 'SETTINGS_OVERVIEW', width, width === 320 ? 200 : 100)
  if (phase === 'before') {
    await page.locator('.settings-group > summary').filter({ hasText: '可用时间' }).click()
    await capture(page, 'SETTINGS_PLANNING', width, width === 320 ? 200 : 100)
  } else {
    await expect(page.locator('.settings-group > summary').filter({ hasText: '可用时间' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存时段', exact: true })).toHaveCount(0)
    await capture(page, 'SETTINGS_PLANNING_RETIRED', width, width === 320 ? 200 : 100)
  }
  await page.locator('.settings-group > summary').filter({ hasText: '岗位发现偏好' }).click()
  await expect(page.locator('.discovery-profile-grid')).toBeVisible()
  await capture(page, 'SETTINGS_DISCOVERY', width, width === 320 ? 200 : 100)
  await page.locator('.settings-group > summary').filter({ hasText: '决策规则' }).click()
  await expect(page.locator('.rules-grid')).toBeVisible()
  await capture(page, 'SETTINGS_RULES', width, width === 320 ? 200 : 100)
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
  await page.locator('.tsui-library-secondary button').filter({ hasText: '发现箱' }).click()
  await page.getByRole('button', { name: '加入 Opportunities', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '加入机会池预览' })).toBeVisible()
  await capture(page, 'DISCOVERY_DETAIL', width, scale)
  await page.locator('.discovery-inbox-modal-actions').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.discovery-inbox-modal')).toHaveCount(0)
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
