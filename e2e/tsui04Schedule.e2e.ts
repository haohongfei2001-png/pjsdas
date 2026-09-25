import { mkdir } from 'node:fs/promises'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { expect, test, type Page } from '@playwright/test'

const NOW = new Date('2026-09-25T04:00:00.000Z')
const CREATED = '2026-09-20T00:00:00.000Z'

async function visual(page: Page, label: string) {
  const bytes = await page.screenshot({ type: 'jpeg', quality: 50, animations: 'disabled' })
  const encoded = bytes.toString('base64')
  console.log('TSUI04_VISUAL_' + label + '_BEGIN')
  for (let index = 0; index < encoded.length; index += 3000) {
    console.log('TSUI04_VISUAL_' + label + '_DATA:' + encoded.slice(index, index + 3000))
  }
  console.log('TSUI04_VISUAL_' + label + '_END')
}

test('TSUI-04 real schedule: today anchor, both directions, unresolved and undated, event detail', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await page.goto('/pjsdas/today')
  await page.evaluate(async ({ created }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'scheduleNodes', 'actions'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.objectStore('opportunities').put({
          id: 'tsui04-opp', company: '时间线公司', role: 'Research / 研究员',
          currentStageLabel: '面试', processStage: 'interview', roleType: 'core',
          participationStatus: 'active', opportunityValue: 80, fitScore: 80,
          importedAt: created,
        })
        for (let index = 0; index < 80; index += 1) {
          const date = new Date(Date.UTC(2026, 8, 24 - index)).toISOString().slice(0, 10)
          tx.objectStore('scheduleNodes').put({
            id: 'tsui04-past-' + index, occurrenceId: 'tsui04-past-occurrence-' + index, version: 1,
            opportunityId: 'tsui04-opp', kind: 'interview', state: 'completed',
            completedAt: date + 'T04:00:00.000Z', constraintKind: 'employer_hard',
            temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai',
              date, resolutionBasis: 'source_explicit' },
            evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
            createdAt: created, updatedAt: date + 'T04:00:00.000Z',
          })
        }
        for (let index = 0; index < 130; index += 1) {
          const date = new Date(Date.UTC(2026, 8, 25 + index)).toISOString().slice(0, 10)
          tx.objectStore('scheduleNodes').put({
            id: 'tsui04-future-' + index, occurrenceId: 'tsui04-future-occurrence-' + index, version: 1,
            opportunityId: 'tsui04-opp', kind: 'interview', state: 'scheduled',
            constraintKind: 'employer_hard',
            temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai',
              date, resolutionBasis: 'source_explicit' },
            evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
            createdAt: created, updatedAt: created,
          })
        }
        tx.objectStore('scheduleNodes').put({
          id: 'tsui04-unresolved', occurrenceId: 'tsui04-unresolved', version: 1,
          opportunityId: 'tsui04-opp', kind: 'assessment', state: 'scheduled',
          constraintKind: 'employer_hard',
          temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai',
            date: '2026-09-23', resolutionBasis: 'source_explicit' },
          evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
          createdAt: created, updatedAt: created,
        })
        tx.objectStore('actions').put({
          id: 'tsui04-undated-action', kind: 'manual', title: '历史完成时间未知',
          estimatedMinutes: 15, leverage: 70, delayCost: 70, status: 'done',
          createdAt: created, updatedAt: created,
        })
      }
    })
  }, { created: CREATED })
  await page.reload()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /日程|Schedule/ }).click()
  await expect(page).toHaveURL(/\/schedule$/)
  await expect(page.locator('.tsui-schedule-tabs button.active')).toContainText(/全部|All/)
  await expect(page.locator('.tsui-schedule-context')).toContainText(/待确认|Unresolved/)
  await expect(page.locator('.tsui-schedule-context')).toContainText(/时间待定|Time TBD/)
  await expect(page.locator('.tsui-schedule-panel .tsui-schedule-row').first()).toBeVisible()
  await mkdir('test-results/tsui04', { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('TSUI04_ENV:' + JSON.stringify(await page.evaluate(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rootFontPx: getComputedStyle(document.documentElement).fontSize,
    viewport: [innerWidth, innerHeight],
  }))))
  const scheduleWidth = await page.locator('.tsui-schedule-page').evaluate((element) => element.getBoundingClientRect().width)
  console.log('TSUI04_SCHEDULE_WIDTH:' + scheduleWidth)
  expect(scheduleWidth).toBeLessThanOrEqual(1122)
  await page.screenshot({ path: 'test-results/tsui04/schedule-desktop.png', fullPage: true, animations: 'disabled' })
  await visual(page, 'SCHEDULE_DESKTOP')

  await page.locator('.tsui-schedule-locator input').fill('2026-12')
  await expect(page.locator('.tsui-schedule-date').first()).toContainText('2026-12')
  await page.locator('.tsui-schedule-locator button').click()
  await expect(page.locator('.tsui-schedule-tabs button.active')).toContainText(/全部|All/)
  while (await page.locator('.tsui-schedule-more').count()) await page.locator('.tsui-schedule-more').click()
  const early = await page.locator('.tsui-schedule-row').first().getAttribute('data-schedule-entry')
  expect(early).toBe('node:tsui04-past-79')
  while (await page.locator('.tsui-load-more').count()) await page.locator('.tsui-load-more').click()
  const ids = await page.locator('.tsui-schedule-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-schedule-entry')))
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids.length).toBe(211)

  await page.locator('.tsui-schedule-tabs').getByRole('button', { name: /已发生|Past/ }).click()
  expect(await page.locator('.tsui-schedule-row').count()).toBeGreaterThan(0)
  while (await page.locator('.tsui-load-more').count()) await page.locator('.tsui-load-more').click()
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(80)
  await page.locator('.tsui-schedule-tabs').getByRole('button', { name: /接下来|Upcoming/ }).click()
  await page.locator('.tsui-schedule-row').first().click()
  const detail = page.locator('.tsui-schedule-detail')
  await expect(detail).toContainText('时间线公司')
  await expect(detail).toContainText(/具体时间待定|Exact time TBD/)
  await expect(detail).toContainText(/连接权威工作区|Connect the authoritative workspace/)
  await expect(detail.getByRole('button', { name: /查看岗位详情|View job details/ })).toBeVisible()
  await expect.poll(() => detail.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(80)
  await page.screenshot({ path: 'test-results/tsui04/event-detail-desktop.png', fullPage: true, animations: 'disabled' })
  await visual(page, 'EVENT_DETAIL_DESKTOP')
  await detail.getByRole('button', { name: /关闭详情|Close details/ }).click()

  await page.locator('.tsui-schedule-context').getByRole('button', { name: /过去安排待确认|Past arrangements to confirm/ }).click()
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(1)
  await page.locator('.tsui-schedule-row').click()
  await expect(page.locator('.tsui-schedule-detail')).toContainText(/结果仍待确认|outcome is unconfirmed/)
  await page.locator('.tsui-schedule-detail').getByRole('button', { name: /关闭详情|Close details/ }).click()
  await page.locator('.tsui-schedule-context').getByRole('button', { name: /时间待定|Time TBD/ }).click()
  await expect(page.locator('.tsui-schedule-row')).toHaveCount(1)

  await page.locator('.tsui-schedule-context').getByRole('button', { name: /返回全部|Back to all/ }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/tsui04/schedule-mobile.png', fullPage: true, animations: 'disabled' })
  await visual(page, 'SCHEDULE_MOBILE')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 320, height: 640 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: 'test-results/tsui04/schedule-large-text-320.png', fullPage: true, animations: 'disabled' })

  await page.locator('.tsui-tell-button').click()
  const capture = page.getByRole('dialog', { name: /告诉 PJSDAS|Tell PJSDAS/ })
  await expect(capture).toBeVisible()
  await expect(capture).not.toContainText('⌘ Enter')
  await page.screenshot({ path: 'test-results/tsui04/capture-mobile.png', fullPage: true, animations: 'disabled' })
  await visual(page, 'CAPTURE_MOBILE')
  await capture.getByRole('button', { name: /关闭|Close/ }).click()
  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  await expect(page.locator('.settings-surface > .surface-header h1')).toHaveText(/设置|Settings/)
  await page.screenshot({ path: 'test-results/tsui04/settings-mobile.png', fullPage: true, animations: 'disabled' })
  await visual(page, 'SETTINGS_MOBILE')
})


test('TSUI-04 connected event detail uses exact occurrence commands, receipt and Undo', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  const account = 'tsui04-account'
  const authKey = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
  const backend = 'https://pjsdas-remote-alpha.vercel.app'
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, { key: authKey, value: {
    access_token: 'tsui04-token', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    refresh_token: 'refresh-tsui04-token',
    user: { id: account, aud: 'authenticated', role: 'authenticated',
      email: 'tsui04@example.test', email_confirmed_at: CREATED, phone: '',
      confirmed_at: CREATED, last_sign_in_at: CREATED,
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { sub: account }, identities: [], created_at: CREATED,
      updated_at: CREATED, is_anonymous: false },
  } })
  const initial = upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot', version: 1, exportedAt: CREATED,
    data: {
      opportunities: [{ id: 'exact-opp', company: '权威公司', role: 'Researcher',
        currentStageLabel: '面试', processStage: 'interview', roleType: 'core',
        participationStatus: 'active', opportunityValue: 80, fitScore: 80, importedAt: CREATED }],
      processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
      scheduleNodes: [{ id: 'schedule:exact-occurrence:v1', occurrenceId: 'exact-occurrence', version: 1,
        opportunityId: 'exact-opp', kind: 'interview', state: 'scheduled',
        constraintKind: 'employer_hard',
        temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai',
          date: '2026-10-20', resolutionBasis: 'source_explicit' },
        evidenceRefs: ['test:source'], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
        createdAt: CREATED, updatedAt: CREATED }],
    },
  } as PJSDASSnapshot)
  const state = { revision: 7, snapshot: initial }
  const original = structuredClone(initial)
  const commands: Array<Record<string, any>> = []
  const receipts = new Map<string, Record<string, unknown>>()
  let snapshotWrites = 0
  await page.route(backend + '/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const respond = (body: unknown, status = 200) => route.fulfill({
      status, headers: { 'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'cache-control': 'no-store', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (request.method() === 'OPTIONS') return respond({}, 204)
    if (url.pathname === '/api/health') return respond({
      status: 'ok', version: '1.10.0-alpha.1', mode: 'transactional-connected',
      workspaceAuthority: 'transactional', capabilities: { deploymentPortability: true },
    })
    if (url.pathname !== '/api/workspace') return respond({ code: 'NOT_FOUND' }, 404)
    const body = request.postDataJSON() as any
    if (body.action === 'read') return respond({ workspaceId: 'ws-tsui04',
      workspaceVersion: 'txn:' + state.revision, revision: state.revision,
      schemaVersion: state.snapshot.version, snapshot: state.snapshot })
    if (body.action === 'commit') {
      snapshotWrites += 1
      return respond({ code: 'SNAPSHOT_WRITE_FORBIDDEN' }, 400)
    }
    if (body.action === 'command') {
      commands.push(body)
      if (body.command?.type !== 'domain') return respond({ code: 'UNEXPECTED_COMMAND' }, 400)
      const applied = applyUserDomainCommand(state.snapshot, body.command.value)
      if (applied.status !== 'APPLIED') return respond({ code: applied.status }, 400)
      state.snapshot = applied.snapshot
      state.revision += 1
      const receipt = { commandId: body.commandId, receiptId: 'receipt:' + body.commandId,
        status: 'COMMITTED', revision: state.revision, undoAvailable: true,
        affectedObjects: [{ type: 'schedule_occurrence', id: 'exact-occurrence' }],
        result: { type: 'domain', status: 'APPLIED', summary: applied.summary } }
      receipts.set(body.commandId, receipt)
      return respond({ outcome: 'COMMITTED', revision: state.revision,
        workspaceVersion: 'txn:' + state.revision, schemaVersion: state.snapshot.version,
        snapshot: state.snapshot, receipt })
    }
    if (body.action === 'receipt') return respond({ found: receipts.has(body.commandId),
      revision: state.revision, workspaceVersion: 'txn:' + state.revision,
      schemaVersion: state.snapshot.version, snapshot: state.snapshot,
      receipt: receipts.get(body.commandId) })
    if (body.action === 'undo') {
      state.snapshot = structuredClone(original)
      state.revision += 1
      return respond({ outcome: 'COMMITTED', revision: state.revision,
        workspaceVersion: 'txn:' + state.revision, schemaVersion: state.snapshot.version,
        snapshot: state.snapshot,
        receipt: { commandId: body.commandId, receiptId: 'receipt:' + body.commandId,
          status: 'COMMITTED', revision: state.revision, undoOf: body.targetCommandId,
          affectedObjects: [{ type: 'schedule_occurrence', id: 'exact-occurrence' }],
          result: { type: 'undo', status: 'APPLIED' } } })
    }
    return respond({ code: 'UNEXPECTED_ACTION' }, 400)
  })
  await page.goto('/pjsdas/schedule')
  const row = page.locator('.tsui-schedule-row').filter({ hasText: '权威公司' })
  await expect(row).toHaveCount(1)
  await row.click()
  await page.locator('.tsui-schedule-command-buttons').getByRole('button', { name: /确认完成|Mark complete/ }).click()
  await page.locator('.tsui-schedule-confirm').getByRole('button', { name: /确认|Confirm/ }).click()
  await expect(page.locator('.tsui-schedule-feedback')).toContainText(/已确认完成|marked complete/)
  expect(commands).toHaveLength(1)
  expect(commands[0].command.value).toMatchObject({ kind: 'complete_occurrence', occurrenceId: 'exact-occurrence' })
  expect(commands[0]).not.toHaveProperty('snapshot')
  expect(state.snapshot.data.scheduleNodes?.some((node) => node.occurrenceId === 'exact-occurrence' && node.state === 'completed')).toBe(true)
  await page.locator('.tsui-schedule-feedback').getByRole('button', { name: /撤销|Undo/ }).click()
  await expect(page.locator('.tsui-schedule-feedback')).toContainText(/已撤销|undone/)
  await expect(row).toHaveCount(1)
  await row.click()
  await page.locator('.tsui-schedule-command-buttons').getByRole('button', { name: /改期|Reschedule/ }).click()
  await page.locator('.tsui-schedule-reschedule input').fill('2026-11-02')
  await page.locator('.tsui-schedule-reschedule').getByRole('button', { name: /确认改期|Confirm reschedule/ }).click()
  await expect(page.locator('.tsui-schedule-feedback')).toContainText(/已按确认日期改期|rescheduled/)
  expect(commands[1].command.value).toMatchObject({ kind: 'reschedule_occurrence',
    occurrenceId: 'exact-occurrence', temporal: { shape: 'date_only', precision: 'date',
      date: '2026-11-02', resolutionBasis: 'user_explicit' } })
  expect(state.snapshot.data.scheduleNodes?.filter((node) => node.occurrenceId === 'exact-occurrence' && node.state === 'scheduled')).toHaveLength(1)
  expect(snapshotWrites).toBe(0)
})
