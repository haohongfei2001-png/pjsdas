import { expect, test } from '@playwright/test'

test('CGR-03 opportunity detail resolves its scheduled interview through contextual capture', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-23T12:00:00.000Z') })
  await page.goto('/')
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'scheduleNodes'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.objectStore('opportunities').put({
          id: 'cgr03-interview-opp', company: '合成访谈公司', role: '研究员',
          currentStageLabel: '面试', processStage: 'interview', roleType: 'core',
          participationStatus: 'active', early: false, opportunityValue: 80, fitScore: 80,
          importedAt: '2026-09-22T12:00:00.000Z',
        })
        tx.objectStore('scheduleNodes').put({
          id: 'schedule:cgr03-interview:v1', occurrenceId: 'cgr03-interview', version: 1,
          opportunityId: 'cgr03-interview-opp', kind: 'interview', state: 'scheduled',
          temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC',
            startAt: '2026-09-24T12:00:00.000Z', endAt: '2026-09-24T13:00:00.000Z',
            resolutionBasis: 'user_explicit' },
          constraintKind: 'employer_hard', evidenceRefs: [], sourceVersionRefs: [],
          relatedActionIds: [], relatedPrepIds: [],
          createdAt: '2026-09-22T12:00:00.000Z', updatedAt: '2026-09-22T12:00:00.000Z',
        })
      }
    })
  })
  await page.reload()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /岗位库|Jobs/ }).click()
  await page.locator('.opportunity-decision-row').filter({ hasText: '合成访谈公司' }).click()
  const detail = page.locator('.job-detail-page')
  await expect(detail.locator('.opportunity-detail-nearest-node')).toContainText(/面试|Interview/)
  await detail.getByRole('button', { name: /更新这个节点|Update this event/ }).click()
  const capture = page.getByRole('dialog', { name: /告诉 PJSDAS|Tell PJSDAS/ })
  await expect(capture).toContainText('合成访谈公司 · 研究员')
  await capture.getByRole('textbox', { name: /要告诉 PJSDAS 的内容|What to tell PJSDAS/ }).fill('这次面试已经完成了。')
  await expect(capture.locator('.cgr-understanding')).toContainText(/面试已完成|Interview completed/)
  await capture.getByRole('button', { name: /确认并保存|Confirm and save/ }).click()
  await expect(capture.getByRole('status')).toContainText(/已保存|处理结果|Saved|Result/)
  await expect.poll(() => page.evaluate(async () => {
    return new Promise<boolean>((resolve) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('scheduleNodes', 'readonly')
        const all = tx.objectStore('scheduleNodes').getAll()
        all.onsuccess = () => { db.close(); resolve(all.result.some((node) => node.occurrenceId === 'cgr03-interview' && node.state === 'completed')) }
      }
    })
  })).toBe(true)
})
