import { expect, test, type Page } from '@playwright/test'

async function seedContext(page: Page, state: 'scheduled' | 'completed' | 'missing') {
  await page.clock.install({ time: new Date('2026-09-23T12:00:00.000Z') })
  await page.goto('/')
  await page.evaluate(async state => {
    const { exportLocalSnapshot, replaceLocalSnapshotFromCloud } = await import('/pjsdas/src/db.ts')
    const snapshot = await exportLocalSnapshot()
    snapshot.data.opportunities = ['a', 'b'].map(id => ({
      id: `cgr03-${id}`, company: id === 'a' ? '合成访谈公司' : '另一个公司', role: '研究员',
      currentStageLabel: '面试', processStage: 'interview', roleType: 'core', participationStatus: 'active',
      early: false, opportunityValue: 80, fitScore: 80, importedAt: '2026-09-22T12:00:00.000Z',
    }))
    snapshot.data.scheduleNodes = ['a', 'b'].filter(id => id !== 'a' || state !== 'missing').map(id => ({
      id: `schedule:cgr03-${id}:v1`, occurrenceId: `cgr03-${id}-interview`, version: 1, opportunityId: `cgr03-${id}`,
      kind: 'interview', state: id === 'a' && state === 'completed' ? 'completed' : 'scheduled',
      temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-09-24T12:00:00.000Z',
        endAt: '2026-09-24T13:00:00.000Z', resolutionBasis: 'user_explicit' },
      constraintKind: 'employer_hard', evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
      createdAt: '2026-09-22T12:00:00.000Z', updatedAt: '2026-09-22T12:00:00.000Z',
    }))
    await replaceLocalSnapshotFromCloud(snapshot)
  }, state)
  await page.reload()
  await page.locator('.tsui-primary-nav').getByRole('button', { name: /岗位库|Jobs/ }).click()
  await page.locator('.opportunity-decision-row').filter({ hasText: '合成访谈公司' }).click()
}
async function business(page: Page) {
  return page.evaluate(async () => (await (await import('/pjsdas/src/db.ts')).exportLocalSnapshot()).data)
}

test('CGR-03 opportunity detail resolves only its own scheduled interview among two jobs', async ({ page }) => {
  await seedContext(page, 'scheduled')
  const before = await business(page)
  const detail = page.locator('.job-detail-page')
  await expect(detail.locator('.opportunity-detail-nearest-node')).toContainText(/面试|Interview/)
  await detail.getByRole('button', { name: /更新这个节点|Update this event/ }).click()
  const capture = page.getByRole('dialog', { name: /告诉 TodayAction|Tell TodayAction/ })
  await expect(capture).toContainText('合成访谈公司 · 研究员')
  await capture.getByRole('textbox', { name: /要告诉 TodayAction 的内容|What to tell TodayAction/ }).fill('这次面试已经完成了。')
  await expect(capture.locator('.cgr-understanding')).toContainText(/面试已完成|Interview completed/)
  await capture.getByRole('button', { name: /确认并保存|Confirm and save/ }).click()
  await expect(capture.getByRole('status')).toContainText(/已保存|处理结果|Saved|Result/)
  await expect.poll(async () => (await business(page)).scheduleNodes?.some(node => node.occurrenceId === 'cgr03-a-interview' && node.state === 'completed')).toBe(true)
  expect((await business(page)).scheduleNodes?.filter(node => node.opportunityId === 'cgr03-b')).toEqual(before.scheduleNodes?.filter(node => node.opportunityId === 'cgr03-b'))
})

for (const state of ['completed', 'missing'] as const) test(`CGR-03 selected ${state} interview cannot fall through to another job`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedContext(page, state)
  await page.locator('.job-detail-page .job-detail-capture').click()
  const capture = page.getByRole('dialog', { name: /告诉 TodayAction|Tell TodayAction/ })
  await expect(capture).toContainText('合成访谈公司 · 研究员')
  const before = await business(page)
  await capture.getByRole('textbox', { name: /要告诉 TodayAction 的内容|What to tell TodayAction/ }).fill('这次面试已经完成了。')
  await expect(capture.locator('.cgr-understanding li')).toHaveCount(0)
  await capture.getByRole('button', { name: /确认并保存|Confirm and save/ }).click()
  await expect(capture.getByRole('status')).toContainText('整条输入尚未保存')
  expect(await business(page)).toEqual(before)
  await page.reload()
  expect(await business(page)).toEqual(before)
})
