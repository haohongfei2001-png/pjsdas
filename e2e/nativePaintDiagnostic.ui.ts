import { MOCK_TARGET_AUTH_ORIGIN } from './support/mockCloudTargets.js'
import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { BACKEND, cors, health, seedSession, workspace } from './fixtures/todayWorkspace.js'
import { validateSnapshot } from '../src/snapshot.js'

const phase = process.env.TA_SECONDARY_PHASE === 'before' ? 'before' : 'after'
const evidence = `secondary-ui-${phase}`
const now = '2026-09-23T08:00:00.000Z'
const diagnoseRaster = process.env.TA_SECONDARY_DIAG === '1'

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

async function capture(page: Page, label: string, width: number) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; window.scrollTo(0, 0) })
  await page.evaluate(() => document.fonts.ready)
  await mkdir(evidence, { recursive: true })
  await page.screenshot({ path: `${evidence}/${label}-${width}.png`, fullPage: true, animations: 'disabled', caret: 'hide' })
}

// Read-only native compositor evidence. Keep this separate from the original
// screenshot journey: instrumentation cannot replace or relax its exact gate.
// Protocol: https://chromedevtools.github.io/devtools-protocol/tot/LayerTree/
for (const width of [1440, 390]) test(`native paint records locate navigation residuals at ${width}`, async ({ page }) => {
  test.skip(!diagnoseRaster, 'Bounded native diagnostic only')
  const mutations = await seed(page, true)
  const session = await page.context().newCDPSession(page)
  let layers: any[] = []
  const paints: any[] = []
  session.on('LayerTree.layerTreeDidChange', event => { layers = event.layers ?? [] })
  session.on('LayerTree.layerPainted', event => { paints.push(event) })
  await session.send('LayerTree.enable')
  const record = async (label: string) => {
    const prefix = `${evidence}/NATIVE_${label}-${width}`
    await page.screenshot({ path: `${prefix}.png`, fullPage: true, animations: 'disabled', caret: 'hide' })
    const records: any[] = []
    for (const layer of layers.filter(layer => layer.drawsContent && layer.width && layer.height)) {
      const record: any = { layer }
      let snapshotId: string | undefined
      try {
        snapshotId = (await session.send('LayerTree.makeSnapshot', { layerId: layer.layerId })).snapshotId
        record.commands = (await session.send('LayerTree.snapshotCommandLog', { snapshotId })).commandLog
        record.reasons = await session.send('LayerTree.compositingReasons', { layerId: layer.layerId })
        const { dataURL } = await session.send('LayerTree.replaySnapshot', { snapshotId })
        await writeFile(`${prefix}.layer-${layer.layerId}.png`, Buffer.from(dataURL.slice(dataURL.indexOf(',') + 1), 'base64'))
      } catch (error) { record.error = String(error) }
      finally { if (snapshotId) await session.send('LayerTree.releaseSnapshot', { snapshotId }) }
      records.push(record)
    }
    await writeFile(`${prefix}.json`, JSON.stringify({ layers, paints, records }, null, 2))
    expect(records.length, 'native content layers must be observable').toBeGreaterThan(0)
    expect(records.some(record => record.commands?.length), 'at least one native paint record must be captured').toBe(true)
  }
  try {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    await page.goto('/pjsdas/today')
    await expect(page.locator('.tsui-task-row[data-action-id]')).toHaveCount(2)
    await capture(page, 'NATIVE_JOURNEY_TODAY', width)
    await page.locator('.tsui-primary-nav').getByRole('button', { name: '岗位库', exact: true }).click()
    await expect(page.locator('.tsui-job-open')).toHaveCount(2)
    await capture(page, 'NATIVE_JOURNEY_JOBS', width)
    await page.locator('.tsui-primary-nav').getByRole('button', { name: '日程', exact: true }).click()
    await expect(page.locator('.tsui-schedule-row')).toHaveCount(1)
    await capture(page, 'NATIVE_JOURNEY_SCHEDULE', width)
    if (width === 1440) await record('SCHEDULE')
    await page.locator('.tsui-topbar').getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible()
    await capture(page, 'NATIVE_JOURNEY_SETTINGS', width)
    await page.locator('.tsui-primary-nav').getByRole('button', { name: '今天', exact: true }).click()
    await expect(page.locator('.tsui-task-row[data-action-id]')).toHaveCount(2)
    await capture(page, 'NATIVE_JOURNEY_AFTER_SETTINGS', width)
    if (width === 390) await record('AFTER_SETTINGS')
    expect(mutations).toEqual([])
  } finally { await session.detach() }
})

