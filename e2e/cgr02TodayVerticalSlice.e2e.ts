import { mkdir } from 'node:fs/promises'
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

const AUTH_KEY = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
const BACKEND = 'https://pjsdas-remote-alpha.vercel.app'
const VISUAL_DIR = 'test-results/cgr02-visual'

function session(accountKey: string, token: string) {
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 31_536_000,
    expires_at: Math.floor(Date.now() / 1000) + 31_536_000,
    refresh_token: `refresh-${token}`,
    user: {
      id: accountKey,
      aud: 'authenticated',
      role: 'authenticated',
      email: `${accountKey}@example.test`,
      email_confirmed_at: '2026-09-23T00:00:00.000Z',
      phone: '',
      confirmed_at: '2026-09-23T00:00:00.000Z',
      last_sign_in_at: '2026-09-23T00:00:00.000Z',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { sub: accountKey, full_name: accountKey },
      identities: [],
      created_at: '2026-09-23T00:00:00.000Z',
      updated_at: '2026-09-23T00:00:00.000Z',
      is_anonymous: false,
    },
  }
}

async function seedSession(context: BrowserContext, accountKey = 'account-a', token = 'token-a') {
  await context.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, { key: AUTH_KEY, value: session(accountKey, token) })
}

function opportunity(id: string, company: string, role: string) {
  return {
    id,
    company,
    role,
    currentStageLabel: '待投递',
    processStage: 'not_applied' as const,
    roleType: 'core' as const,
    participationStatus: 'active' as const,
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    assessmentStatus: 'unassessed' as const,
    locallyManaged: true,
    importedAt: '2026-09-23T00:00:00.000Z',
  }
}

function action(id: string, title: string, opportunityId?: string, leverage = 70) {
  return {
    id,
    kind: 'manual' as const,
    title,
    opportunityId,
    estimatedMinutes: 20,
    leverage,
    delayCost: leverage,
    status: 'todo' as const,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  }
}

function workspace(): PJSDASSnapshot {
  return upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-23T00:00:00.000Z',
    data: {
      opportunities: [
        opportunity('A-opp-1', 'A公司', '产品经理'),
        opportunity('A-opp-2', '第二公司', '策略产品'),
      ],
      processes: [],
      processEvents: [],
      actions: [
        action('A-action-1', 'A第一任务', 'A-opp-1', 86),
        action('A-action-2', 'A第二任务', 'A-opp-2', 60),
      ],
      prep: [],
      applicationGroups: [],
      semanticReceipts: [],
      timeline: [],
    },
  })
}

function health() {
  return {
    status: 'ok',
    version: '1.10.0-alpha.1',
    mode: 'transactional-connected',
    workspaceAuthority: 'transactional',
    capabilities: { deploymentPortability: true },
  }
}

function cors(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

interface State {
  revision: number
  snapshot: PJSDASSnapshot
  receipts: Map<string, Record<string, unknown>>
  commandBodies: any[]
  failReads?: boolean
}

function responseFor(state: State, extra: Record<string, unknown> = {}) {
  return {
    revision: state.revision,
    workspaceVersion: `txn:${state.revision}`,
    schemaVersion: state.snapshot.version,
    snapshot: state.snapshot,
    ...extra,
  }
}

function installServer(page: Page, state: State, options: {
  loseFirstSemanticResponse?: boolean
  loseFirstReceiptLookup?: boolean
  delaySemanticMs?: number
} = {}) {
  let lostCommand = false
  let lostReceipt = false
  return page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = request.postDataJSON() as any

    if (body.action === 'read') {
      if (state.failReads) return cors(route, { code: 'TEMPORARY_UNAVAILABLE' }, 503)
      return cors(route, {
        workspaceId: 'ws-a',
        ...responseFor(state),
      })
    }

    if (body.action === 'receipt') {
      if (options.loseFirstReceiptLookup && !lostReceipt) {
        lostReceipt = true
        return route.abort('failed')
      }
      const receipt = state.receipts.get(body.commandId)
      return cors(route, responseFor(state, {
        found: Boolean(receipt),
        receipt,
      }))
    }

    if (body.action === 'command' && body.command?.type === 'semantic_intake') {
      state.commandBodies.push(body)
      if (options.delaySemanticMs) await new Promise((resolve) => setTimeout(resolve, options.delaySemanticMs))
      const commandId = String(body.commandId)
      if (!state.receipts.has(commandId)) {
        const candidate = body.command?.value?.candidates?.find((item: any) => item.kind === 'manual_action')
        const title = candidate?.title ?? '整理面试材料'
        state.snapshot.data.actions.push(action('capture-action', title, undefined, 99))
        const updatedAt = '2026-09-23T05:10:00.000Z'
        state.snapshot.data.semanticReceipts ??= []
        state.snapshot.data.semanticReceipts.push({
          id: `semantic-receipt:${commandId}`,
          inputId: body.command.value.inputId,
          sourceKind: 'web',
          sourceId: 'todayaction-web',
          sourceRecordId: body.command.value.source.sourceRecordId,
          commandId,
          status: 'committed',
          summary: `已记录：${title}`,
          affectedObjects: [{ type: 'action', id: 'capture-action' }],
          decisionRequestIds: [],
          undoAvailable: true,
          createdAt: updatedAt,
          updatedAt,
        })
        state.revision += 1
        state.receipts.set(commandId, {
          commandId,
          receiptId: `command-receipt:${commandId}`,
          status: 'COMMITTED',
          revision: state.revision,
          undoAvailable: true,
          affectedObjects: [{ type: 'action', id: 'capture-action' }],
          result: {
            type: 'semantic_intake',
            status: 'APPLIED',
            summary: `已记录：${title}`,
            decisionRequestIds: [],
          },
        })
      }
      const receipt = state.receipts.get(commandId)!
      if (options.loseFirstSemanticResponse && !lostCommand) {
        lostCommand = true
        return route.abort('failed')
      }
      return cors(route, responseFor(state, {
        outcome: 'COMMITTED',
        receipt,
        result: receipt.result,
      }))
    }

    if (body.action === 'undo') {
      state.commandBodies.push(body)
      state.snapshot.data.actions = state.snapshot.data.actions.filter((item) => item.id !== 'capture-action')
      const semantic = state.snapshot.data.semanticReceipts?.find((item) => item.commandId === body.targetCommandId)
      if (semantic) {
        semantic.status = 'undone'
        semantic.undoAvailable = false
        semantic.updatedAt = '2026-09-23T05:12:00.000Z'
      }
      state.revision += 1
      const receipt = {
        commandId: body.commandId,
        receiptId: `command-receipt:${body.commandId}`,
        status: 'COMMITTED',
        revision: state.revision,
        undoOf: body.targetCommandId,
        affectedObjects: [{ type: 'action', id: 'capture-action' }],
        result: { type: 'undo', status: 'APPLIED' },
      }
      state.receipts.set(body.commandId, receipt)
      return cors(route, responseFor(state, {
        outcome: 'COMMITTED',
        receipt,
      }))
    }

    return cors(route, { code: 'UNEXPECTED_ACTION', action: body.action }, 400)
  })
}

async function indexedActions(page: Page) {
  return page.evaluate(async () => new Promise<Array<{ id: string; title: string; status: string }>>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('actions', 'readonly')
      const get = tx.objectStore('actions').getAll()
      get.onerror = () => reject(get.error)
      get.onsuccess = () => { db.close(); resolve(get.result) }
    }
  }))
}

test('CGR-02 golden journey: understand -> authoritative save -> cross-client visibility -> dependency-safe Undo', async ({ browser }) => {
  const state: State = { revision: 20, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  await seedSession(contextA)
  await seedSession(contextB)
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  await installServer(pageA, state)
  await installServer(pageB, state)

  await pageA.goto('/pjsdas/today')
  await pageB.goto('/pjsdas/today')
  await expect(pageA.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect(pageB.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  await pageA.getByRole('button', { name: '岗位详情' }).click()
  await expect(pageA).toHaveURL(/\/pjsdas\/opportunities\/A-opp-1$/)
  const opener = pageA.locator('.opportunity-detail-drawer .cgr-context-capture')
  await opener.click()
  await expect(pageA).toHaveURL(/\/pjsdas\/today\/capture$/)
  await expect(pageA.getByText('当前上下文：A公司 · 产品经理')).toBeVisible()

  const input = pageA.locator('.cgr-capture-input')
  await input.fill('事项：整理面试材料')
  await expect(pageA.getByText('PJSDAS 理解为')).toBeVisible()
  await expect(pageA.getByText(/新增行动 · 整理面试材料/)).toBeVisible()
  await expect(pageA.getByText('尚未保存')).toBeVisible()

  await pageA.getByRole('button', { name: '确认并保存' }).click()
  await expect(pageA.getByText('已保存')).toBeVisible()
  await expect(pageA.getByRole('status').getByText(/已记录：整理面试材料/)).toBeVisible()

  const semanticCommand = state.commandBodies.find((body) => body.action === 'command')
  expect(semanticCommand.command.value.contextRefs).toEqual(['opportunity:A-opp-1'])
  expect(semanticCommand).not.toHaveProperty('snapshot')

  // Today is the route behind the capture sheet, so the authoritative projection updates
  // immediately without a navigation/reload even while the saved receipt remains available.
  await expect(pageA.locator('.cgr-recent-section').getByText('已记录：整理面试材料')).toHaveCount(1)
  await expect(pageA.getByText('PJSDAS 刚处理的变化')).toHaveCount(1)

  const propagatedAt = Date.now()
  await pageB.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(pageB.locator('.cgr-recent-section').getByText('已记录：整理面试材料')).toBeVisible({ timeout: 15_000 })
  const propagationMs = Date.now() - propagatedAt
  expect(propagationMs).toBeLessThan(15_000)

  const unrelated = state.snapshot.data.actions.find((item) => item.id === 'A-action-2')
  if (unrelated) {
    unrelated.status = 'done'
    unrelated.updatedAt = '2026-09-23T05:11:00.000Z'
  }
  state.revision += 1

  await pageA.getByRole('button', { name: '撤销' }).click()
  await expect(pageA.getByText(/其他后续更新保持不变/)).toBeVisible()

  const finalActions = await indexedActions(pageA)
  expect(finalActions.find((item) => item.id === 'A-action-2')?.status).toBe('done')
  expect(finalActions.find((item) => item.id === 'capture-action')).toBeUndefined()

  await pageA.getByRole('button', { name: '关闭' }).click()
  await expect(opener).toBeFocused()
  await pageA.locator('.opportunity-detail-drawer').getByRole('button', { name: /回到 Today|Back to Today/ }).click()
  await mkdir(VISUAL_DIR, { recursive: true })
  await pageA.screenshot({ path: `${VISUAL_DIR}/normal-desktop.png`, fullPage: true })

  await contextA.close()
  await contextB.close()
})

test('unknown semantic save keeps one stable command identity and recovers by receipt before retry', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 30, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state, { loseFirstSemanticResponse: true, loseFirstReceiptLookup: true })

  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await page.locator('.cgr-global-capture').click()
  await page.locator('.cgr-capture-input').fill('事项：整理面试材料')
  await page.getByRole('button', { name: '确认并保存' }).click()

  await expect(page.getByRole('alert')).toContainText('保存结果暂时未知')
  await expect(page.getByRole('alert')).toContainText('确认保存状态')
  await expect(page.getByRole('alert')).not.toContainText(/UNKNOWN_COMMAND_OUTCOME|commandId|Failed to fetch/)
  await expect(page.getByText('正在理解…')).toHaveCount(0)
  await expect(page.locator('.cgr-capture-input')).toBeDisabled()
  await mkdir(VISUAL_DIR, { recursive: true })
  await page.screenshot({ path: `${VISUAL_DIR}/unknown-save.png` })
  const firstCommand = state.commandBodies.find((body) => body.action === 'command')
  expect(firstCommand).toBeTruthy()
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(1)

  await page.getByRole('button', { name: '关闭' }).click()
  await page.locator('.cgr-global-capture').click()
  await expect(page.getByRole('alert')).toContainText('保存结果暂时未知')
  await expect(page.locator('.cgr-capture-input')).toBeDisabled()
  await page.getByRole('button', { name: '确认保存状态' }).click()
  await expect(page.getByText('已保存')).toBeVisible()
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(1)
  const pending = await page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-pending:account-a'))
  expect(pending).toBeNull()
})

test('offline capture remains account-scoped draft only and legacy capture route redirects canonically', async ({ page, context }) => {
  await seedSession(context)
  const state: State = { revision: 40, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state)

  await page.goto('/pjsdas/capture')
  await expect(page).toHaveURL(/\/pjsdas\/today\/capture$/)
  await context.setOffline(true)
  await page.locator('.cgr-capture-input').fill('事项：离线整理材料')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByText('仅草稿')).toBeVisible()
  await expect(page.getByText(/还没有写入 PJSDAS/)).toBeVisible()
  await mkdir(VISUAL_DIR, { recursive: true })
  await page.screenshot({ path: `${VISUAL_DIR}/offline-draft.png` })
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(0)
  const draft = await page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-draft:account-a:tell-pjsdas'))
  expect(draft).toBe('事项：离线整理材料')
  await context.setOffline(false)
})

test('Today remains operable at phone width and large text without horizontal clipping', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedSession(page.context())
  const state: State = { revision: 50, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state)

  await page.goto('/pjsdas/today')
  await page.evaluate(() => { document.documentElement.style.fontSize = '125%' })
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const firstActionTop = await page.locator('.cgr-primary-action').evaluate((node) => node.getBoundingClientRect().top)
  const agendaTop = await page.locator('.cgr-agenda').evaluate((node) => node.getBoundingClientRect().top)
  expect(firstActionTop).toBeLessThan(agendaTop)
  const metrics = await page.locator('[data-testid="cgr02-today"]').evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  const primary = page.getByRole('button', { name: '开始' }).first()
  await expect(primary).toBeInViewport()
  await primary.focus()
  await expect(primary).toBeFocused()
  await page.locator('.cgr-next-section').scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: '完成' }).first()).toBeInViewport()
  await mkdir(VISUAL_DIR, { recursive: true })
  await page.screenshot({ path: `${VISUAL_DIR}/phone-large-text.png`, fullPage: true })
})

test('pending authoritative save is visibly pending until its receipt arrives', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 55, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state, { delaySemanticMs: 1_200 })

  await page.goto('/pjsdas/today')
  await page.locator('.cgr-global-capture').click()
  await page.locator('.cgr-capture-input').fill('事项：整理面试材料')
  await expect(page.getByText(/新增行动 · 整理面试材料/)).toBeVisible()
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByText('正在保存')).toBeVisible()
  await expect(page.getByText('已保存')).toHaveCount(0)
  await mkdir(VISUAL_DIR, { recursive: true })
  await page.screenshot({ path: `${VISUAL_DIR}/pending-save.png` })
  await expect(page.getByText('已保存')).toBeVisible()
})

test('cached Today stays useful when authoritative refresh fails', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 60, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state)

  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  state.failReads = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('使用缓存 · 暂时无法刷新')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始' }).first()).toBeEnabled()
  await mkdir(VISUAL_DIR, { recursive: true })
  await page.screenshot({ path: `${VISUAL_DIR}/cached-refresh-failure.png` })
})

test('quiet Today and a real DecisionRequest remain legible without invented actions', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 70, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  state.snapshot.data.actions = []
  await installServer(page, state)

  await page.goto('/pjsdas/today')
  await expect(page.getByText('现在没有必须处理的行动')).toBeVisible()
  await expect(page.locator('.cgr-primary-action')).toHaveCount(0)
  await mkdir(VISUAL_DIR, { recursive: true })
  await page.screenshot({ path: `${VISUAL_DIR}/quiet-today.png` })

  const now = new Date().toISOString()
  state.snapshot.data.decisionRequests = [{
    id: 'decision-a',
    reason: 'ambiguous_target',
    affectedObjects: [{ type: 'opportunity', id: 'A-opp-1' }],
    question: '这条更新属于哪个岗位？',
    choices: [
      { id: 'choose-a', label: 'A公司 · 产品经理', consequence: '只更新这个岗位' },
      { id: 'choose-b', label: '第二公司 · 策略产品', consequence: '只更新另一个岗位' },
    ],
    evidenceRefs: ['test-evidence-a'],
    payloadBinding: {
      contractVersion: 1,
      inputId: 'input-a',
      candidateId: 'candidate-a',
      source: { kind: 'web', sourceId: 'web-a', sourceRecordId: 'input-a', observedAt: now, timezone: 'Asia/Shanghai' },
      statementMode: 'assertion',
      candidate: {
        id: 'candidate-a', kind: 'manual_action', title: '确认岗位',
        objectConfidence: 'low', eventConfidence: 'high', evidenceRefs: ['test-evidence-a'], sourceVersionRefs: [],
      },
    },
    state: 'open',
    createdAt: now,
    updatedAt: now,
  }]
  state.revision += 1
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.cgr-decision-entry')).toBeVisible()
  await expect(page.getByText('现在没有必须处理的行动')).toBeVisible()
  await page.screenshot({ path: `${VISUAL_DIR}/decision-required.png` })
})
