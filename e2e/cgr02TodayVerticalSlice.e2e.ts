import { mkdir } from 'node:fs/promises'
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

const AUTH_KEY = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
const BACKEND = 'https://pjsdas-remote-alpha.vercel.app'
const VISUAL_DIR = 'test-results/cgr02-visual'
const VISUAL_TIME = new Date('2026-09-23T08:00:00.000Z')

async function reviewedScreenshot(page: Page, name: string, fullPage = false) {
  await mkdir(VISUAL_DIR, { recursive: true })
  const screenshot = await page.screenshot({ path: `${VISUAL_DIR}/${name}`, fullPage, animations: 'disabled' })
  expect(screenshot.byteLength).toBeGreaterThan(1000)
  const reviewNames = new Set(['quiet-today.png', 'decision-required.png', 'pending-save.png', 'unknown-save.png', 'offline-draft.png', 'conflict-save.png', 'cached-refresh-failure.png', 'single-390-200.png', 'single-320-200.png', 'capture-320-200.png'])
  if (reviewNames.has(name)) {
    const encoded = (await page.screenshot({ type: 'jpeg', quality: 46, animations: 'disabled' })).toString('base64')
    console.log(`TSUI05_VISUAL_${name}_BEGIN`)
    for (let offset = 0; offset < encoded.length; offset += 3000) console.log(`TSUI05_VISUAL_${name}_DATA:${encoded.slice(offset, offset + 3000)}`)
    console.log(`TSUI05_VISUAL_${name}_END`)
  }
}

test.beforeEach(async ({ page }) => {
  // Screenshot copy and relative dates must remain stable across CI days.
  await page.clock.setFixedTime(VISUAL_TIME)
})

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
  holdSemantic?: Promise<void>
  holdRead?: Promise<void>
  expireSemantic?: boolean
  conflictSemantic?: boolean
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
      if (options.holdRead) await options.holdRead
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
      if (options.expireSemantic) return cors(route, { code: 'SESSION_EXPIRED' }, 401)
      if (options.conflictSemantic) {
        state.revision += 1
        state.snapshot.data.actions[0].title = 'A第一任务（另一客户端更新）'
        return cors(route, responseFor(state, {
          outcome: 'CONFLICT',
          conflict: {
            kind: 'OBJECT_CONFLICT',
            message: '同一行动已被另一客户端更新；请核对最新事实。',
            objects: [{ type: 'action', id: 'A-action-1' }],
            interveningCommandIds: ['other-client-action-update'],
          },
        }), 409)
      }
      if (options.holdSemantic) await options.holdSemantic
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
  await pageA.clock.setFixedTime(VISUAL_TIME)
  await pageB.clock.setFixedTime(VISUAL_TIME)
  await installServer(pageA, state)
  await installServer(pageB, state)

  await pageA.goto('/pjsdas/today')
  await pageB.goto('/pjsdas/today')
  await expect(pageA.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect(pageB.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  await pageA.locator('.tsui-task-context').first().click()
  await expect(pageA).toHaveURL(/\/pjsdas\/library\/A-opp-1$/)
  const opener = pageA.locator('.job-detail-actions .job-detail-capture')
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
  await expect(pageA.getByRole('heading', { name: '整理面试材料' })).toBeVisible()

  const propagatedAt = Date.now()
  await pageB.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(pageB.getByRole('heading', { name: '整理面试材料' })).toBeVisible({ timeout: 15_000 })
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
  await pageA.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(pageA.locator('.tsui-status')).toHaveCount(0)
  await reviewedScreenshot(pageA, 'normal-desktop.png', true)

  await contextA.close()
  await contextB.close()
})

test('Today capture supports a keyboard-only save with named controls and restored focus', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 25, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state)
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  const opener = page.locator('.tsui-tell-button')
  for (let step = 0; step < 30 && !(await opener.evaluate((node) => node === document.activeElement)); step += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(opener).toBeFocused()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog', { name: '告诉 PJSDAS' })
  const input = dialog.getByRole('textbox', { name: '要告诉 PJSDAS 的内容' })
  await expect(dialog).toBeVisible()
  await expect(input).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: '关闭' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(input).toBeFocused()

  await page.keyboard.type('事项：整理面试材料')
  await expect(dialog.getByText(/新增行动 · 整理面试材料/)).toBeVisible()
  await page.keyboard.press('Tab')
  const save = dialog.getByRole('button', { name: '确认并保存' })
  await expect(save).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('status')).toContainText('已记录：整理面试材料')
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(opener).toBeFocused()
})

test('unknown semantic save keeps one stable command identity and recovers by receipt before retry', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 30, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state, { loseFirstSemanticResponse: true, loseFirstReceiptLookup: true })

  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await page.locator('.tsui-tell-button').click()
  await page.locator('.cgr-capture-input').fill('事项：整理面试材料')
  await page.getByRole('button', { name: '确认并保存' }).click()

  await expect(page.getByRole('alert')).toContainText('保存结果暂时未知')
  await expect(page.getByRole('alert')).toContainText('确认保存状态')
  await expect(page.getByRole('alert')).not.toContainText(/UNKNOWN_COMMAND_OUTCOME|commandId|Failed to fetch/)
  await expect(page.getByText('正在理解…')).toHaveCount(0)
  await expect(page.locator('.cgr-capture-input')).toBeDisabled()
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'unknown-save.png')
  const firstCommand = state.commandBodies.find((body) => body.action === 'command')
  expect(firstCommand).toBeTruthy()
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(1)

  // Another recovery path may have resolved and cleared the pending record
  // while this dialog still remembers the original command identity.
  await page.evaluate(() => window.localStorage.removeItem('pjsdas-cgr01-pending:account-a'))
  await page.getByRole('button', { name: '确认保存状态' }).click()
  await expect(page.getByText('已保存')).toBeVisible()
  const sentCommands = state.commandBodies.filter((body) => body.action === 'command')
  expect(sentCommands.every((body) => body.commandId === firstCommand.commandId
    && body.command.value.inputId === firstCommand.command.value.inputId)).toBe(true)
  expect(state.snapshot.data.actions.filter((item) => item.id === 'capture-action')).toHaveLength(1)
  const pending = await page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-pending:account-a'))
  expect(pending).toBeNull()
})

test('background receipt recovery removes only the matching committed draft', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 35, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state, { loseFirstSemanticResponse: true, loseFirstReceiptLookup: true })

  await page.goto('/pjsdas/today')
  await page.locator('.tsui-tell-button').click()
  await page.locator('.cgr-capture-input').fill('事项：整理面试材料')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('alert')).toContainText('保存结果暂时未知')
  await page.reload()
  await expect(page.getByRole('heading', { name: '整理面试材料' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-pending:account-a'))).toBeNull()
  expect(await page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-draft:account-a:tell-pjsdas'))).toBeNull()
  await page.getByRole('button', { name: '关闭' }).click()
  await page.locator('.tsui-tell-button').click()
  await expect(page.locator('.cgr-capture-input')).toBeEmpty()
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(1)
})

test('background receipt recovery preserves a newer draft from another editing context', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 36, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state, { loseFirstSemanticResponse: true, loseFirstReceiptLookup: true })

  await page.goto('/pjsdas/today')
  await page.locator('.tsui-tell-button').click()
  await page.locator('.cgr-capture-input').fill('事项：整理面试材料')
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('alert')).toContainText('保存结果暂时未知')
  await page.evaluate(() => window.localStorage.setItem('pjsdas-cgr01-draft:account-a:tell-pjsdas', '事项：新的未提交想法'))
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-pending:account-a'))).toBeNull()
  expect(await page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-draft:account-a:tell-pjsdas'))).toBe('事项：新的未提交想法')
  await expect(page.locator('.cgr-capture-input')).toHaveValue('事项：新的未提交想法')
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(1)
})

test('offline capture remains account-scoped draft only and legacy capture route redirects canonically', async ({ page, context }) => {
  await seedSession(context)
  const state: State = { revision: 40, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state)

  await page.goto('/pjsdas/capture')
  await expect(page).toHaveURL(/\/pjsdas\/today\/capture$/)
  await context.setOffline(true)
  await page.locator('.cgr-capture-input').fill('事项：离线整理材料')
  const save = page.getByRole('button', { name: '确认并保存' })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText('仅草稿')).toBeVisible()
  await expect(page.getByText(/还没有写入 PJSDAS/)).toBeVisible()
  // Capture the settled interpretation, not a race between the loading state
  // and the local offline parser. The draft-only assertion remains separate.
  await expect(page.getByText('PJSDAS 理解为')).toBeVisible()
  await expect(page.getByText(/新增行动 · 离线整理材料/)).toBeVisible()
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'offline-draft.png')
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(0)
  const draft = await page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-draft:account-a:tell-pjsdas'))
  expect(draft).toBe('事项：离线整理材料')
  await context.setOffline(false)
})

test('expired session rejects a connected save before execution and preserves the input', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 41, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state, { expireSemantic: true })
  await page.goto('/pjsdas/today/capture')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const input = page.locator('.cgr-capture-input')
  await input.fill('事项：整理面试材料')
  await expect(page.getByText('PJSDAS 理解为')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认并保存' })).toBeEnabled()
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('alert')).toContainText('登录会话已过期')
  await expect(page.getByRole('alert')).toContainText('重新登录后点“重新确认”')
  await expect(input).toHaveValue('事项：整理面试材料')
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(1)
  expect(state.snapshot.data.actions.some((item) => item.title === '整理面试材料')).toBe(false)
  expect(state.receipts.size).toBe(0)
})

test('same-object conflict refreshes connected Today and keeps the unsaved statement for review', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 42, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state, { conflictSemantic: true })
  await page.goto('/pjsdas/today/capture')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const input = page.locator('.cgr-capture-input')
  await input.fill('事项：整理面试材料')
  await expect(page.getByText('PJSDAS 理解为')).toBeVisible()
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByRole('alert')).toContainText('发现具体事实冲突')
  await expect(page.getByRole('alert')).toContainText('请先核对最新事实')
  await expect(input).toHaveValue('事项：整理面试材料')
  await expect(page.getByRole('heading', { name: 'A第一任务（另一客户端更新）' })).toBeVisible()
  expect(state.commandBodies.filter((body) => body.action === 'command')).toHaveLength(1)
  expect(state.receipts.size).toBe(0)
  await reviewedScreenshot(page, 'conflict-save.png')
})

test('Today remains operable at phone width and large text without horizontal clipping', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedSession(page.context())
  const state: State = { revision: 50, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  await installServer(page, state)

  await page.goto('/pjsdas/today')
  await page.evaluate(() => { document.documentElement.style.fontSize = '125%' })
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect(page.locator('.tsui-task-row').first()).toBeVisible()
  await expect(page.locator('.tsui-node-panel')).toBeHidden()
  await page.getByRole('button', { name: /节点/ }).first().click()
  await expect(page.locator('.tsui-node-panel')).toBeVisible()
  await page.getByRole('button', { name: /任务/ }).first().click()
  const metrics = await page.locator('[data-testid="cgr02-today"]').evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  const primary = page.locator('.tsui-task-row').first().locator('.tsui-row-action')
  await expect(primary).toBeInViewport()
  await primary.focus()
  await expect(primary).toBeFocused()
  await expect(page.locator('.tsui-task-row').first().locator('.tsui-done-action')).toBeVisible()
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'phone-large-text.png', true)
})

test('dense desktop Today keeps the primary action and agenda readable', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 52, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  state.snapshot.data.actions.push(...Array.from({ length: 14 }, (_, index) =>
    action(`dense-${index}`, `第 ${index + 1} 项：准备跨团队评审与面试材料`, index % 2 ? 'A-opp-1' : 'A-opp-2', 65 - index)))
  await installServer(page, state)
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-panel')).toBeVisible()
  await expect(page.locator('.tsui-node-panel')).toBeVisible()
  await expect(page.locator('.tsui-task-row').first()).toBeVisible()
  const width = await page.locator('[data-testid="cgr02-today"]').evaluate((node) => ({
    scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
  }))
  expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1)
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'dense-desktop.png', true)
})

test('connected Today keeps a fixed interview, date-only deadline and elapsed unresolved node distinct', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 54, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  state.snapshot.data.opportunities[0].deadline = '2026-09-25'
  state.snapshot.data.opportunities[0].deadlinePrecision = 'date'
  const base = {
    opportunityId: 'A-opp-1', company: 'A公司', role: '产品经理',
    occurredAt: '2026-09-22T00:00:00.000Z', timingMode: 'fixed' as const,
    estimatedMinutes: 60, source: 'manual' as const,
    createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
  }
  state.snapshot.data.processEvents.push(
    { ...base, id: 'cgr02-upcoming-interview', type: 'interview_invite', dueAt: '2026-09-24T04:00:00.000Z', duePrecision: 'datetime' },
    { ...base, id: 'cgr02-elapsed-interview', type: 'interview_invite', dueAt: '2026-09-21T04:00:00.000Z', duePrecision: 'datetime' },
  )
  await installServer(page, state)
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const upcoming = page.locator('.tsui-node-panel')
  await expect(upcoming.locator('.tsui-node-row').filter({ hasText: '面试' })).toHaveCount(1)
  await expect(upcoming.locator('.tsui-node-row').filter({ hasText: '申请截止' })).toHaveCount(1)
  await expect(page.locator('.tsui-unresolved-link')).toContainText('1')
  await page.locator('.tsui-unresolved-link').click()
  await expect(page).toHaveURL(/\/schedule\?view=unresolved$/)
  await expect(page.locator('.tsui-schedule-panel .tsui-schedule-row')).toHaveCount(1)
})

test('long action text and dense recruiting schedule remain operable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedSession(page.context())
  const state: State = { revision: 55, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  state.snapshot.data.actions[0].title = '整理跨团队面试反馈、岗位要求与个人案例，确认每一项具体证据和下一步行动。'.repeat(5)
  state.snapshot.data.processEvents.push(...Array.from({ length: 12 }, (_, index) => ({
    id: `cgr02-dense-interview-${index}`,
    opportunityId: index % 2 ? 'A-opp-1' : 'A-opp-2',
    company: index % 2 ? 'A公司' : '第二公司',
    role: index % 2 ? '产品经理' : '策略产品',
    type: 'interview_invite' as const,
    occurredAt: '2026-09-22T00:00:00.000Z',
    dueAt: new Date(Date.parse('2026-09-24T01:00:00.000Z') + index * 60 * 60 * 1000).toISOString(),
    duePrecision: 'datetime' as const,
    timingMode: 'fixed' as const,
    estimatedMinutes: 60,
    source: 'manual' as const,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  })))
  await installServer(page, state)
  await page.goto('/pjsdas/today')
  await expect(page.locator('.tsui-task-row').first()).toContainText('整理跨团队面试反馈')
  await expect(page.locator('.tsui-task-row').first().locator('.tsui-row-action')).toBeVisible()
  await page.getByRole('button', { name: /节点/ }).first().click()
  await expect(page.locator('.tsui-node-panel .tsui-node-row')).toHaveCount(12)
  const widths = await page.locator('[data-testid="cgr02-today"]').evaluate((node) => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    surface: node.scrollWidth - node.clientWidth,
  }))
  expect(widths.page).toBeLessThanOrEqual(1)
  expect(widths.surface).toBeLessThanOrEqual(1)
  const firstAgenda = page.locator('.tsui-node-panel .tsui-node-row').first()
  await firstAgenda.scrollIntoViewIfNeeded()
  await expect(firstAgenda).toBeInViewport()
  await firstAgenda.focus()
  await expect(firstAgenda).toBeFocused()
  await mkdir(VISUAL_DIR, { recursive: true })
  await page.screenshot({ path: `${VISUAL_DIR}/long-text-dense-phone.png`, fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 320, height: 640 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const narrowWidths = await page.locator('[data-testid="cgr02-today"]').evaluate((node) => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    surface: node.scrollWidth - node.clientWidth,
  }))
  expect(narrowWidths.page).toBeLessThanOrEqual(1)
  expect(narrowWidths.surface).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: /任务/ }).first().click()
  await page.locator('.tsui-task-row .tsui-row-action').first().scrollIntoViewIfNeeded()
  await expect(page.locator('.tsui-task-row .tsui-row-action').first()).toBeInViewport()
})

test('first load and unavailable read show distinct truthful states', async ({ page, browser }) => {
  await seedSession(page.context())
  const state: State = { revision: 53, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  let releaseRead: () => void = () => {}
  const holdRead = new Promise<void>((resolve) => { releaseRead = resolve })
  await installServer(page, state, { holdRead })
  await page.goto('/pjsdas/today')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)
  await expect(page.getByText('正在确认最新状态…')).toBeVisible()
  await expect(page.getByText('先让 PJSDAS 了解你的求职进展')).toHaveCount(0)
  await expect(page.getByText('这里暂无有依据的记录。')).toHaveCount(0)
  await expect(page.locator('.tsui-task-panel')).toHaveCount(0)
  await expect(page.locator('.tsui-inline-notice')).toHaveCount(0)
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'loading.png')
  releaseRead()
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  const errorContext = await browser.newContext()
  await seedSession(errorContext)
  const errorPage = await errorContext.newPage()
  await errorPage.clock.setFixedTime(VISUAL_TIME)
  state.failReads = true
  await installServer(errorPage, state)
  await errorPage.goto('/pjsdas/today')
  await expect(errorPage.getByText('暂时无法确认今天，请重试。')).toBeVisible()
  await expect(errorPage.getByText('先让 PJSDAS 了解你的求职进展')).toHaveCount(0)
  await expect(errorPage.getByText('这里暂无有依据的记录。')).toHaveCount(0)
  await expect(errorPage.locator('.tsui-inline-notice')).toHaveCount(0)
  await reviewedScreenshot(errorPage, 'read-error.png')
  await errorContext.close()
})

test('pending authoritative save is visibly pending until its receipt arrives', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 55, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  let releaseSemantic: () => void = () => {}
  const holdSemantic = new Promise<void>((resolve) => { releaseSemantic = resolve })
  await installServer(page, state, { holdSemantic })

  await page.goto('/pjsdas/today')
  await page.locator('.tsui-tell-button').click()
  await page.locator('.cgr-capture-input').fill('事项：整理面试材料')
  await expect(page.getByText(/新增行动 · 整理面试材料/)).toBeVisible()
  await page.getByRole('button', { name: '确认并保存' }).click()
  await expect(page.getByText('正在保存')).toBeVisible()
  await expect(page.getByText('已保存')).toHaveCount(0)
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'pending-save.png')
  releaseSemantic()
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
  await expect(page.getByText('使用已验证缓存，暂时无法刷新。')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect(page.locator('.tsui-task-row .tsui-row-action').first()).toBeEnabled()
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'cached-refresh-failure.png')
})

test('quiet Today and a real DecisionRequest remain legible without invented actions', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 70, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  state.snapshot.data.actions = []
  await installServer(page, state)

  await page.goto('/pjsdas/today')
  await expect(page.getByText('现在没有必须处理的任务')).toBeVisible()
  await expect(page.locator('.tsui-task-row')).toHaveCount(0)
  await mkdir(VISUAL_DIR, { recursive: true })
  await reviewedScreenshot(page, 'quiet-today.png')

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
  await expect(page.locator('.tsui-task-row').filter({ hasText: '这条更新属于哪个岗位？' })).toBeVisible()
  await expect(page.locator('.tsui-task-row')).toHaveCount(1)
  await reviewedScreenshot(page, 'decision-required.png')
})

test('TSUI-05 single task remains an ordinary row at 390 and 320 with real 200% text', async ({ page }) => {
  await seedSession(page.context())
  const state: State = { revision: 81, snapshot: workspace(), receipts: new Map(), commandBodies: [] }
  state.snapshot.data.actions = [state.snapshot.data.actions[0]!]
  await installServer(page, state)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/pjsdas/today')
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  const rootFont = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
  expect(rootFont).toBeGreaterThanOrEqual(30)
  await expect(page.locator('.tsui-task-row')).toHaveCount(1)
  await expect(page.locator('.cgr-primary-action')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const width390 = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width390).toBeLessThanOrEqual(391)
  await reviewedScreenshot(page, 'single-390-200.png', true)

  await page.setViewportSize({ width: 320, height: 640 })
  const width320 = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width320).toBeLessThanOrEqual(321)
  await reviewedScreenshot(page, 'single-320-200.png', true)
  await page.locator('.tsui-tell-button').click()
  const dialog = page.getByRole('dialog', { name: '告诉 PJSDAS' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '要告诉 PJSDAS 的内容' })).toBeFocused()
  const dialogWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(dialogWidth).toBeLessThanOrEqual(321)
  await reviewedScreenshot(page, 'capture-320-200.png', true)
})
