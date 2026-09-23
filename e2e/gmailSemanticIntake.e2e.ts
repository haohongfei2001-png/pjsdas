import { expect, test, type Page } from '@playwright/test'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

async function seedSnapshot(page: Page, data: PJSDASSnapshot['data']) {
  await page.evaluate(async (snapshotData) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const collections = ['opportunities', 'processes', 'processEvents', 'actions', 'timeline', 'scheduleNodes', 'decisionRequests', 'semanticReceipts'] as const
        const tx = db.transaction([...collections], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        for (const name of collections) {
          tx.objectStore(name).clear()
          for (const value of snapshotData[name] ?? []) tx.objectStore(name).put(value)
        }
      }
    })
  }, data)
}

for (const fixture of [
  { title: 'multi-event', body: '京东 AI产品经理 笔试通知：统一笔试时间明天 09:00；京东 AI产品经理 面试通知：后天 14:30参加面试' },
  { title: 'window and deadline', body: '京东 AI产品经理 笔试开放窗口明天 09:00至后天 17:00；提交截止后天 18:00' },
]) test(`Gmail ${fixture.title} projects into the real Today agenda and survives reload`, async ({ page }) => {
  const now = new Date('2026-09-21T00:00:00Z')
  const base: PJSDASSnapshot = { schema: 'pjsdas-local-snapshot', version: 1, exportedAt: now.toISOString(), data: {
    opportunities: [{ id: 'uu06-opportunity', company: '京东', role: 'AI产品经理', currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 80, fitScore: 80, locallyManaged: true, importedAt: '2026-09-01T00:00:00Z' }],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
  } }
  const body = fixture.body
  const record = gmailSemanticRecordFromMessage({ id: 'uu06-mail', threadId: 'uu06-thread', internalDate: String(now.getTime()), payload: { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } } }, base.data.opportunities, now)!
  const result = applyGmailSemanticBatch(base, { runId: 'uu06-browser', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
  expect(result.snapshot.data.processEvents).toHaveLength(2)
  if (fixture.title === 'window and deadline') expect(result.snapshot.data.scheduleNodes?.map((node) => node.temporal.shape)).toEqual(['availability_window', 'deadline'])
  await page.clock.install({ time: now })
  await page.goto('/')
  await seedSnapshot(page, result.snapshot.data)
  await page.reload()
  await expect(page.locator('.cgr-agenda-node')).toHaveCount(2)
  await expect(page.locator('.cgr-agenda')).toContainText('京东')
  await expect(page.locator('.cgr-agenda')).toContainText('AI产品经理')
  if (fixture.title === 'window and deadline') {
    await expect(page.locator('.cgr-agenda')).toContainText('可参加')
    await expect(page.locator('.cgr-agenda')).toContainText('截止')
    await expect(page.locator('.cgr-agenda-time').filter({ hasText: '可参加' })).toContainText('–')
  }
  await page.reload()
  await expect(page.locator('.cgr-agenda-node')).toHaveCount(2)
  const stored = await page.evaluate(async () => new Promise<{ events: number; receipts: number }>((resolve, reject) => {
    const request = indexedDB.open('pjsdas', 11)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['processEvents', 'semanticReceipts'], 'readonly')
      const events = tx.objectStore('processEvents').count()
      const receipts = tx.objectStore('semanticReceipts').count()
      tx.oncomplete = () => { db.close(); resolve({ events: events.result, receipts: receipts.result }) }
    }
  }))
  expect(stored).toEqual({ events: 2, receipts: 1 })
})

test('Gmail current reschedule with a quoted old thread shows only the new occurrence in Today', async ({ page }) => {
  const now = new Date('2026-09-21T00:00:00Z')
  const base: PJSDASSnapshot = { schema: 'pjsdas-local-snapshot', version: 1, exportedAt: now.toISOString(), data: {
    opportunities: [{ id: 'uu06-opportunity', company: '京东', role: 'AI产品经理', currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 80, fitScore: 80, locallyManaged: true, importedAt: '2026-09-01T00:00:00Z' }],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
  } }
  const mail = (id: string, body: string) => ({ id, threadId: 'uu06-thread', internalDate: String(now.getTime()), payload: { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } } })
  const firstRecord = gmailSemanticRecordFromMessage(mail('first', '京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试'), base.data.opportunities, now)!
  const first = applyGmailSemanticBatch(base, { runId: 'first', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [firstRecord] })
  const secondRecord = gmailSemanticRecordFromMessage(mail('second', '京东 AI产品经理 面试改期为2026年9月26日 14:30\n> 京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试'), first.snapshot.data.opportunities, now)!
  const second = applyGmailSemanticBatch(first.snapshot, { runId: 'second', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [secondRecord] })
  expect(second.snapshot.data.scheduleNodes?.map((node) => node.state)).toEqual(['superseded', 'scheduled'])
  await page.clock.install({ time: now })
  await page.goto('/')
  await seedSnapshot(page, second.snapshot.data)
  await page.reload()
  await expect(page.locator('.cgr-agenda-node')).toHaveCount(1)
  await expect(page.locator('.cgr-agenda')).toContainText('2026-09-26')
  await expect(page.locator('.cgr-agenda')).not.toContainText('2026-09-25')
})

test('Gmail settings separates a normal attachment boundary from an interpretation failure', async ({ page }) => {
  const now = new Date('2026-09-21T00:00:00Z')
  const base: PJSDASSnapshot = { schema: 'pjsdas-local-snapshot', version: 1, exportedAt: now.toISOString(), data: {
    opportunities: [{ id: 'uu06-opportunity', company: '京东', role: 'AI产品经理', currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 80, fitScore: 80, locallyManaged: true, importedAt: '2026-09-01T00:00:00Z' }],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
  } }
  const mail = { id: 'boundary-mail', threadId: 'boundary-thread', internalDate: String(now.getTime()), payload: {
    mimeType: 'text/plain', body: { data: Buffer.from('京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试').toString('base64url') },
    parts: [{ filename: 'private.pdf', mimeType: 'application/pdf', body: { data: 'secret-attachment-content' } }],
  } }
  const record = gmailSemanticRecordFromMessage(mail, base.data.opportunities, now)!
  const result = applyGmailSemanticBatch(base, { runId: 'boundary-browser', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
  expect(result.run.outcomes.updated).toBe(1)
  expect(JSON.stringify(result.snapshot)).not.toContain('secret-attachment-content')
  await page.clock.install({ time: now })
  await page.goto('/')
  await seedSnapshot(page, result.snapshot.data)
  await page.reload()
  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  const status = page.getByLabel('Gmail 来源结果')
  await expect(status).toContainText('解释失败 0')
  await expect(status).toContainText('正常能力边界 1')
  await status.getByText('查看未读取的内容边界').click()
  await expect(status).toContainText('附件内容尚未读取')
})

test('a completed Gmail intake run reports interpretation failure without guessing a write', async ({ page }) => {
  const now = new Date('2026-09-21T00:00:00Z')
  const base: PJSDASSnapshot = { schema: 'pjsdas-local-snapshot', version: 1, exportedAt: now.toISOString(), data: {
    opportunities: [{ id: 'gmail-failure-opportunity', company: '京东', role: 'AI产品经理', currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 80, fitScore: 80, locallyManaged: true, importedAt: '2026-09-01T00:00:00Z' }],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
  } }
  // Gmail supplied a recruiting message but neither internalDate nor Date header.
  // The interpreter cannot place the fact in time and must leave it unresolved.
  const record = gmailSemanticRecordFromMessage({ id: 'undated-mail', payload: {
    mimeType: 'text/plain', body: { data: Buffer.from('京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试').toString('base64url') },
  } }, base.data.opportunities, now)!
  expect(record.issueKinds).toContain('interpretation_failure')
  const result = applyGmailSemanticBatch(base, { runId: 'undated-browser', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
  expect(result.run).toMatchObject({ receivedCount: 1, accountedCount: 1, outcomes: { unresolved: 1 } })
  expect(result.snapshot.data.processEvents).toHaveLength(0)
  expect(result.snapshot.data.decisionRequests).toHaveLength(1)
  await page.clock.install({ time: now })
  await page.goto('/')
  await seedSnapshot(page, result.snapshot.data)
  await page.reload()
  await page.locator('.ultimate-toolbar').getByRole('button', { name: /设置|Settings/ }).click()
  const status = page.getByLabel('Gmail 来源结果')
  await expect(status).toContainText('解释失败 1')
  await expect(status).toContainText('业务歧义 1')
  await expect(status).toContainText('正常能力边界 0')
})
