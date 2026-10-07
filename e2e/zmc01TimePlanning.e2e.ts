import { expect, test, type Page } from '@playwright/test'
import { createSnapshot } from '../src/snapshot.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { BACKEND, cors, health, seedSession } from './fixtures/todayWorkspace.js'

test.use({ timezoneId: 'Asia/Shanghai' })

test('Today capacity is a durable user choice and flexible overflow leaves the workspace intact', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-25T01:00:00.000Z'))
  await page.goto('/pjsdas/today')
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('actions', 'readwrite')
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve() }
      for (let index = 0; index < 60; index += 1) tx.objectStore('actions').put({
        id: `zmc-task-${index}`, kind: 'manual', title: `可顺延的准备 ${index}`,
        status: 'todo', plannedDate: '2026-09-25', estimatedMinutes: 30, leverage: 70, delayCost: 40,
        dueAt: '2026-09-25', duePrecision: 'date', timingMode: 'deadline',
        createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
      })
    }
  }))
  await page.reload()
  await expect(page.locator('.tsui-task-row')).toHaveCount(30)
  await expect(page.getByText('今天的安排可能超出可用时间')).toHaveCount(0)
  await page.locator('.tsui-capacity summary').click()
  await page.locator('.tsui-capacity input').fill('2')
  await page.locator('.tsui-capacity input').press('Enter')
  await expect(page.locator('.tsui-task-row')).toHaveCount(4)
  await page.reload()
  await expect(page.locator('.tsui-capacity summary')).toContainText('2 小时')
  await expect(page.locator('.tsui-task-row')).toHaveCount(4)
  const persisted = await page.evaluate(async () => new Promise<{ minutes?: number; count: number }>((resolve, reject) => {
    const request = indexedDB.open('pjsdas')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['meta', 'actions'], 'readonly')
      const pref = tx.objectStore('meta').get('timePlanning')
      const count = tx.objectStore('actions').count()
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve({ minutes: pref.result?.dateOverrides?.['2026-09-25'], count: count.result }) }
    }
  }))
  expect(persisted).toEqual({ minutes: 120, count: 60 })
})

test('connected capacity command reaches another client and remains after reload', async ({ browser }) => {
  const now = new Date('2026-09-25T01:00:00.000Z')
  const createdAt = '2026-09-20T00:00:00.000Z'
  const state = { revision: 7, commands: 0, snapshot: createSnapshot({
    opportunities: [], processes: [], processEvents: [], prep: [], applicationGroups: [],
    actions: Array.from({ length: 8 }, (_, index) => ({ id: `account-task-${index}`, kind: 'manual' as const,
      title: `Account task ${index}`, status: 'todo' as const, plannedDate: '2026-09-25', estimatedMinutes: 30,
      leverage: 75, delayCost: 50, dueAt: '2026-09-25', duePrecision: 'date' as const,
      timingMode: 'deadline' as const, createdAt, updatedAt: createdAt })),
  }, now.toISOString()) }
  const contextA = await browser.newContext(), contextB = await browser.newContext()
  try {
    await seedSession(contextA)
    await seedSession(contextB)
    const pageA = await contextA.newPage(), pageB = await contextB.newPage()
    await pageA.clock.setFixedTime(now)
    await pageB.clock.setFixedTime(now)
    const routeBackend = async (page: Page) => page.route(`${BACKEND}/**`, async route => {
      const request = route.request(), url = new URL(request.url())
      if (request.method() === 'OPTIONS') return cors(route, {}, 204)
      if (url.pathname === '/api/health') return cors(route, health())
      if (url.pathname !== '/api/workspace') return cors(route, { code: 'NOT_FOUND' }, 404)
      const body = request.postDataJSON() as any
      const response = (extra: Record<string, unknown> = {}) => ({ workspaceId: 'zmc-account',
        revision: state.revision, workspaceVersion: `txn:${state.revision}`,
        schemaVersion: state.snapshot.version, snapshot: state.snapshot, ...extra })
      if (body.action === 'read') return cors(route, response())
      if (body.action === 'command' && body.command?.type === 'domain') {
        state.commands += 1
        expect(body.command.value).toMatchObject({ kind: 'set_date_capacity', date: '2026-09-25', minutes: 120 })
        const applied = applyUserDomainCommand(state.snapshot, body.command.value, now)
        expect(applied.status).toBe('APPLIED')
        state.snapshot = applied.snapshot
        state.revision += 1
        return cors(route, response({ outcome: 'COMMITTED', receipt: { commandId: body.commandId,
          receiptId: `receipt:${body.commandId}`, status: 'COMMITTED', revision: state.revision,
          affectedObjects: [{ type: 'time_planning', id: '2026-09-25' }],
          result: { type: 'domain', status: 'APPLIED', summary: applied.summary } } }))
      }
      return cors(route, { code: 'UNEXPECTED_WRITE' }, 400)
    })
    await routeBackend(pageA)
    await routeBackend(pageB)
    await pageA.goto('/pjsdas/today')
    await pageB.goto('/pjsdas/today')
    await expect(pageA.locator('.tsui-task-row')).toHaveCount(8)
    await pageA.locator('.tsui-capacity summary').click()
    await pageA.locator('.tsui-capacity input').fill('2')
    await pageA.locator('.tsui-capacity input').press('Enter')
    await expect(pageA.locator('.tsui-task-row')).toHaveCount(4)
    await pageB.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(pageB.locator('.tsui-task-row')).toHaveCount(4)
    await pageB.reload()
    await expect(pageB.locator('.tsui-capacity summary')).toContainText('2 小时')
    expect(state.commands).toBe(1)
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
