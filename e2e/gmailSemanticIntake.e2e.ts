import { expect, test } from '@playwright/test'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

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
  await page.evaluate(async (data) => {
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
          for (const value of data[name] ?? []) tx.objectStore(name).put(value)
        }
      }
    })
  }, result.snapshot.data)
  await page.reload()
  await expect(page.locator('.ultimate-agenda-node')).toHaveCount(2)
  await expect(page.locator('.ultimate-agenda')).toContainText('京东')
  await expect(page.locator('.ultimate-agenda')).toContainText('AI产品经理')
  if (fixture.title === 'window and deadline') {
    await expect(page.locator('.ultimate-agenda')).toContainText('可参加')
    await expect(page.locator('.ultimate-agenda')).toContainText('截止')
    await expect(page.locator('.ultimate-agenda-time').filter({ hasText: '可参加' })).toContainText('–')
  }
  await page.reload()
  await expect(page.locator('.ultimate-agenda-node')).toHaveCount(2)
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
