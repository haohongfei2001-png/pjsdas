import { expect, test, type Page, type Route } from '@playwright/test'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

const AUTH_KEY = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
const BACKEND = 'https://pjsdas-remote-alpha.vercel.app'

function action(id: string, title: string, opportunityId: string) {
  return {
    id,
    kind: 'manual' as const,
    title,
    opportunityId,
    estimatedMinutes: 15,
    leverage: 70,
    delayCost: 70,
    status: 'todo' as const,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  }
}

function opportunity(id: string, company: string, role: string) {
  return {
    id,
    company,
    role,
    currentStageLabel: '待投递',
    processStage: 'not_applied' as const,
    roleType: 'core' as const,
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    assessmentStatus: 'unassessed' as const,
    locallyManaged: true,
    importedAt: '2026-09-23T00:00:00.000Z',
  }
}

function workspace(prefix: string): PJSDASSnapshot {
  return upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-23T00:00:00.000Z',
    data: {
      opportunities: [
        opportunity(`${prefix}-opp-1`, `${prefix}公司`, `${prefix}产品经理`),
        opportunity(`${prefix}-opp-2`, `${prefix}第二公司`, `${prefix}第二岗位`),
      ],
      processes: [],
      processEvents: [],
      actions: [
        action(`${prefix}-action-1`, `${prefix}第一任务`, `${prefix}-opp-1`),
        action(`${prefix}-action-2`, `${prefix}第二任务`, `${prefix}-opp-2`),
      ],
      prep: [],
      applicationGroups: [],
      timeline: [],
    },
  })
}

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

async function seedInitialSession(page: Page, accountKey: string, token: string) {
  await page.addInitScript(({ key, value }) => {
    if (!window.localStorage.getItem('cgr01-e2e-auth-seeded')) {
      window.localStorage.setItem(key, JSON.stringify(value))
      window.localStorage.setItem('cgr01-e2e-auth-seeded', '1')
    }
  }, { key: AUTH_KEY, value: session(accountKey, token) })
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

function health() {
  return {
    status: 'ok',
    version: '1.10.0-alpha.1',
    mode: 'transactional-connected',
    workspaceAuthority: 'transactional',
    capabilities: { deploymentPortability: true },
  }
}

interface AccountState {
  revision: number
  snapshot: PJSDASSnapshot
  receipts: Map<string, Record<string, unknown>>
}

function tokenOf(route: Route) {
  const auth = route.request().headers()['authorization'] ?? ''
  return auth.replace(/^Bearer\s+/i, '')
}

async function readIndexedActions(page: Page) {
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

test('lost response after server commit survives reload and recovers one durable receipt without duplicate mutation', async ({ page }) => {
  await seedInitialSession(page, 'account-a', 'token-a')
  const state: AccountState = { revision: 7, snapshot: workspace('A'), receipts: new Map() }
  let commandCalls = 0
  let receiptCalls = 0

  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)

    const body = request.postDataJSON() as any
    if (body.action === 'read') {
      return cors(route, {
        workspaceId: 'ws-a',
        workspaceVersion: `txn:${state.revision}`,
        revision: state.revision,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
      })
    }
    if (body.action === 'command') {
      commandCalls += 1
      const target = state.snapshot.data.actions.find((item) => item.id === 'A-action-1')
      if (target) target.status = 'done'
      state.revision += 1
      const receipt = {
        commandId: body.commandId,
        receiptId: `command-receipt:${body.commandId}`,
        status: 'COMMITTED',
        revision: state.revision,
        undoAvailable: true,
        affectedObjects: [{ type: 'action', id: 'A-action-1' }],
        result: { type: 'domain', status: 'APPLIED', summary: 'Completed A-action-1.' },
      }
      state.receipts.set(body.commandId, receipt)
      return route.abort('failed')
    }
    if (body.action === 'receipt') {
      receiptCalls += 1
      if (receiptCalls === 1) return route.abort('failed')
      const receipt = state.receipts.get(body.commandId)
      return cors(route, {
        found: Boolean(receipt),
        revision: state.revision,
        workspaceVersion: `txn:${state.revision}`,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
        receipt,
      })
    }
    return cors(route, { code: 'UNEXPECTED_ACTION', action: body.action }, 400)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await page.getByRole('button', { name: '标记完成' }).click()
  await expect(page.getByRole('status')).toContainText('尚未确认这次操作是否已提交')
  expect(commandCalls).toBe(1)
  expect(receiptCalls).toBe(1)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)
  expect(commandCalls).toBe(1)
  expect(receiptCalls).toBeGreaterThanOrEqual(2)
  const pending = await page.evaluate(() => window.localStorage.getItem('pjsdas-cgr01-pending:account-a'))
  expect(pending).toBeNull()
})

test('connected Web recovers a lost command response and Undo preserves unrelated later state', async ({ page }) => {
  await seedInitialSession(page, 'account-a', 'token-a')
  const state: AccountState = { revision: 7, snapshot: workspace('A'), receipts: new Map() }
  const commandBodies: any[] = []
  let loseFirstResponse = true

  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)

    const body = request.postDataJSON() as any
    if (body.action === 'read') {
      return cors(route, {
        workspaceId: 'ws-a',
        workspaceVersion: `txn:${state.revision}`,
        revision: state.revision,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
      })
    }
    if (body.action === 'command') {
      commandBodies.push(body)
      const commandId = body.commandId as string
      const target = state.snapshot.data.actions.find((item) => item.id === 'A-action-1')
      if (target) {
        target.status = 'done'
        target.updatedAt = '2026-09-23T01:00:00.000Z'
      }
      state.revision += 1
      const receipt = {
        commandId,
        receiptId: `command-receipt:${commandId}`,
        status: 'COMMITTED',
        revision: state.revision,
        undoAvailable: true,
        affectedObjects: [{ type: 'action', id: 'A-action-1' }],
        result: { type: 'domain', status: 'APPLIED', summary: 'Completed A-action-1.' },
      }
      state.receipts.set(commandId, receipt)
      if (loseFirstResponse) {
        loseFirstResponse = false
        return route.abort('failed')
      }
      return cors(route, {
        outcome: 'COMMITTED',
        revision: state.revision,
        workspaceVersion: `txn:${state.revision}`,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
        receipt,
        result: receipt.result,
      })
    }
    if (body.action === 'receipt') {
      const receipt = state.receipts.get(body.commandId)
      return cors(route, {
        found: Boolean(receipt),
        revision: state.revision,
        workspaceVersion: `txn:${state.revision}`,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
        receipt,
      })
    }
    if (body.action === 'undo') {
      expect(body.targetCommandId).toBe(commandBodies[0]?.commandId)
      const original = state.snapshot.data.actions.find((item) => item.id === 'A-action-1')
      if (original) {
        original.status = 'todo'
        original.updatedAt = '2026-09-23T01:10:00.000Z'
      }
      state.revision += 1
      return cors(route, {
        outcome: 'COMMITTED',
        revision: state.revision,
        workspaceVersion: `txn:${state.revision}`,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
        receipt: {
          commandId: body.commandId,
          receiptId: `command-receipt:${body.commandId}`,
          status: 'COMMITTED',
          revision: state.revision,
          undoOf: body.targetCommandId,
          affectedObjects: [{ type: 'action', id: 'A-action-1' }],
          result: { type: 'undo', status: 'APPLIED' },
        },
      })
    }
    return cors(route, { code: 'UNEXPECTED_ACTION', action: body.action }, 400)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  await page.getByRole('button', { name: '标记完成' }).click()
  await expect(page.getByRole('status')).toContainText('已标记完成')
  expect(commandBodies).toHaveLength(1)
  expect(commandBodies[0]).toMatchObject({
    action: 'command',
    command: { type: 'domain', value: { kind: 'set_action_status', actionId: 'A-action-1', status: 'done' } },
  })
  expect(commandBodies[0]).not.toHaveProperty('snapshot')

  const unrelated = state.snapshot.data.actions.find((item) => item.id === 'A-action-2')
  if (unrelated) {
    unrelated.status = 'done'
    unrelated.updatedAt = '2026-09-23T01:05:00.000Z'
  }
  state.revision += 1

  await page.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const actions = await readIndexedActions(page)
  expect(actions.find((item) => item.id === 'A-action-1')?.status).toBe('todo')
  expect(actions.find((item) => item.id === 'A-action-2')?.status).toBe('done')
})

test('same-object connected conflict is concrete and refreshes the authoritative cache', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedInitialSession(page, 'account-a', 'token-a')
  const state: AccountState = { revision: 4, snapshot: workspace('A'), receipts: new Map() }

  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = request.postDataJSON() as any
    if (body.action === 'read') {
      return cors(route, {
        workspaceId: 'ws-a',
        workspaceVersion: `txn:${state.revision}`,
        revision: state.revision,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
      })
    }
    if (body.action === 'command') {
      const target = state.snapshot.data.actions.find((item) => item.id === 'A-action-1')
      if (target) target.status = 'doing'
      state.revision += 1
      return cors(route, {
        outcome: 'CONFLICT',
        revision: state.revision,
        workspaceVersion: `txn:${state.revision}`,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
        conflict: {
          kind: 'OBJECT_CONFLICT',
          message: '这一个行动已被另一客户端修改；PJSDAS 保留较新的权威状态。',
          objects: [{ type: 'action', id: 'A-action-1' }],
          interveningCommandIds: ['other-client-command'],
        },
      }, 409)
    }
    return cors(route, { found: false, revision: state.revision, workspaceVersion: `txn:${state.revision}`, schemaVersion: state.snapshot.version, snapshot: state.snapshot })
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  const complete = page.getByRole('button', { name: '标记完成' })
  await complete.focus()
  await expect(complete).toBeFocused()
  await page.keyboard.press('Enter')
  const conflictStatus = page.getByRole('status')
  await expect(conflictStatus).toContainText('这一个行动已被另一客户端修改')
  await expect(conflictStatus).toBeInViewport()
  const actions = await readIndexedActions(page)
  expect(actions.find((item) => item.id === 'A-action-1')?.status).toBe('doing')
  await expect(page.getByText(/本地还是云端|local.*cloud/i)).toHaveCount(0)
})

test('account A sign-out then account B never displays or replays A cache drafts or pending operations', async ({ page }) => {
  await seedInitialSession(page, 'account-a', 'token-a')
  const states: Record<string, AccountState> = {
    'token-a': { revision: 3, snapshot: workspace('A'), receipts: new Map() },
    'token-b': { revision: 11, snapshot: workspace('B'), receipts: new Map() },
  }
  const bBodies: any[] = []

  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const token = tokenOf(route)
    const state = states[token]
    if (!state) return cors(route, { code: 'AUTH_REQUIRED' }, 401)
    const body = request.postDataJSON() as any
    if (token === 'token-b') bBodies.push(body)
    if (body.action === 'read') {
      return cors(route, {
        workspaceId: token === 'token-a' ? 'ws-a' : 'ws-b',
        workspaceVersion: `txn:${state.revision}`,
        revision: state.revision,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
      })
    }
    if (body.action === 'receipt') {
      const receipt = state.receipts.get(body.commandId)
      return cors(route, {
        found: Boolean(receipt),
        revision: state.revision,
        workspaceVersion: `txn:${state.revision}`,
        schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
        receipt,
      })
    }
    return cors(route, { code: 'UNEXPECTED_WRITE', action: body.action }, 409)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()

  await page.locator('.ultimate-capture-button').click()
  await page.locator('.cgr-capture-input').fill('A 的私有草稿')
  await page.getByRole('button', { name: '关闭' }).click()
  await page.evaluate(() => {
    window.localStorage.setItem('pjsdas-cgr01-pending:account-a', JSON.stringify([{
      commandId: 'web-action:A-pending',
      action: 'command',
      baseRevision: 3,
      command: {
        type: 'domain',
        value: { commandId: 'web-action:A-pending', kind: 'set_action_status', actionId: 'A-action-1', status: 'done' },
      },
      status: 'unknown',
      createdAt: '2026-09-23T01:00:00.000Z',
      updatedAt: '2026-09-23T01:00:00.000Z',
    }]))
  })

  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  await page.getByRole('button', { name: '退出 PJSDAS' }).click()
  await expect.poll(async () => (await readIndexedActions(page)).length).toBe(0)
  await page.locator('.surface-nav').getByRole('button', { name: /今天|Today/ }).click()
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)

  await page.evaluate(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, { key: AUTH_KEY, value: session('account-b', 'token-b') })
  await page.goto('/pjsdas/today')

  await expect(page.getByRole('heading', { name: 'B第一任务' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toHaveCount(0)
  await page.locator('.ultimate-capture-button').click()
  await expect(page.locator('.cgr-capture-input')).toHaveValue('')
  expect(bBodies.some((body) => body.commandId === 'web-action:A-pending')).toBe(false)
  expect(bBodies.some((body) => ['commit', 'command', 'undo'].includes(body.action))).toBe(false)
})

test('CGR-05 background connected refresh leaves local legacy changes pending without whole-snapshot commit', async ({ page }) => {
  await seedInitialSession(page, 'account-a', 'token-a')
  const state: AccountState = { revision: 7, snapshot: workspace('A'), receipts: new Map() }
  let reads = 0
  let commits = 0
  await page.route(`${BACKEND}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (url.pathname === '/api/health') return cors(route, health())
    if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
    const body = request.postDataJSON() as { action?: string }
    if (body.action === 'read') {
      reads += 1
      return cors(route, { workspaceId: 'ws-a', workspaceVersion: `txn:${state.revision}`,
        revision: state.revision, schemaVersion: state.snapshot.version, snapshot: state.snapshot })
    }
    if (body.action === 'commit') commits += 1
    return cors(route, { code: 'UNEXPECTED_WRITE', action: body.action }, 409)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'A第一任务' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem('pjsdas-google-drive-sync-state-v2')
    return raw ? (JSON.parse(raw) as { accounts?: Record<string, { lastSyncedVersion?: string }> }).accounts?.['account-a']?.lastSyncedVersion : undefined
  })).toBe('txn:7')

  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('actions', 'readwrite')
      const store = tx.objectStore('actions')
      const get = store.get('A-action-1')
      get.onsuccess = () => store.put({ ...get.result, title: '本地待处理修改' })
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve() }
    }
  }))
  const priorReads = reads
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => reads).toBeGreaterThan(priorReads)
  expect(commits).toBe(0)
  expect((await readIndexedActions(page)).find((item) => item.id === 'A-action-1')?.title).toBe('本地待处理修改')
})
