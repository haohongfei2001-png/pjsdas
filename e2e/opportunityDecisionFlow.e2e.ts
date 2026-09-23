import { expect, test } from '@playwright/test'

test('CGR-03 dense mixed-language workspace keeps search, identity, and return focus', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const importedAt = new Date(Date.now() - 86400000).toISOString()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        for (let index = 0; index < 240; index += 1) {
          tx.objectStore('opportunities').put({
            id: `cgr03-dense-${index}`, company: `合成公司 CGR03-${index}`,
            role: index === 239 ? 'Senior Product and Human-Centered Systems Research / 高级产品与认知系统研究岗位' : `Engineer / 研究 ${index}`,
            currentStageLabel: '面试', processStage: 'interview', roleType: 'core',
            participationStatus: 'active', early: false, opportunityValue: 80,
            fitScore: 80, importedAt,
          })
        }
      }
    })
  })
  await page.reload()
  await page.locator('.surface-nav').getByRole('button', { name: /机会|Opportunities/ }).click()
  const rows = page.locator('.opportunity-decision-row')
  await expect(rows).toHaveCount(240)
  const search = page.getByRole('textbox', { name: /搜索公司或岗位|Search company or role/ })
  await search.fill('CGR03-239')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('高级产品与认知系统研究岗位')
  await rows.first().click()
  await expect(page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })).toContainText('CGR03-239')
  await page.keyboard.press('Escape')
  await expect(rows.first()).toBeFocused()
  await expect(search).toHaveValue('CGR03-239')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(rows.first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('cgr03-dense-phone-390.png'), fullPage: true })
  await rows.first().click()
  await expect(page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('cgr03-long-detail-390.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 320, height: 640 })
  await expect(rows.first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('cgr03-dense-narrow-320.png'), fullPage: true })
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect.poll(async () => page.evaluate(() => {
    const row = document.querySelector('.opportunity-decision-row')?.getBoundingClientRect()
    const capture = document.querySelector('.ultimate-mobile-capture')?.getBoundingClientRect()
    return Boolean(row && capture && row.bottom <= capture.top - 4)
  })).toBe(true)
  await rows.first().click()
  await expect(page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('cgr03-long-detail-320.png'), fullPage: true })
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  await expect(page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('cgr03-long-detail-large-text-320.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(rows.first()).toBeFocused()
  await expect(search).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true)
})

test('UU-05 Opportunities centers In Progress / Worth Pursuing and opens conclusion-first detail', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const now = Date.now()
    const opportunities = [
      {
        id: 'uu05-interview',
        company: '推进科技',
        role: 'AI产品经理',
        currentStageLabel: '面试',
        processStage: 'interview',
        roleType: 'core',
        participationStatus: 'active',
        early: false,
        opportunityValue: 90,
        fitScore: 88,
        importedAt: new Date(now - 5 * 86400000).toISOString(),
      },
      {
        id: 'uu05-worth',
        company: '值得科技',
        role: '产品经理',
        currentStageLabel: '待投递',
        processStage: 'not_applied',
        roleType: 'core',
        participationStatus: 'active',
        early: true,
        deadline: new Date(now + 48 * 3600000).toISOString(),
        deadlinePrecision: 'datetime',
        opportunityValue: 89,
        fitScore: 86,
        importedAt: new Date(now - 2 * 86400000).toISOString(),
      },
      {
        id: 'uu05-ended',
        company: '结束科技',
        role: '项目经理',
        currentStageLabel: '流程结束',
        processStage: 'closed',
        roleType: 'backup',
        participationStatus: 'active',
        early: false,
        opportunityValue: 72,
        fitScore: 70,
        importedAt: new Date(now - 8 * 86400000).toISOString(),
      },
    ]
    const actions = [
      {
        id: 'uu05-interview-action',
        kind: 'manual',
        title: '准备推进科技面试',
        opportunityId: 'uu05-interview',
        processStage: 'interview',
        estimatedMinutes: 30,
        leverage: 96,
        delayCost: 94,
        status: 'todo',
        createdAt: new Date(now - 86400000).toISOString(),
        updatedAt: new Date(now - 86400000).toISOString(),
      },
      {
        id: 'uu05-apply-action',
        kind: 'apply',
        title: '提交值得科技产品经理申请',
        opportunityId: 'uu05-worth',
        processStage: 'not_applied',
        dueAt: new Date(now + 48 * 3600000).toISOString(),
        duePrecision: 'datetime',
        timingMode: 'deadline',
        estimatedMinutes: 35,
        leverage: 90,
        delayCost: 92,
        status: 'todo',
        createdAt: new Date(now - 86400000).toISOString(),
        updatedAt: new Date(now - 86400000).toISOString(),
      },
      {
        id: 'uu05-ended-stale-action', kind: 'apply', title: '过期的结束流程待办',
        opportunityId: 'uu05-ended', processStage: 'closed', estimatedMinutes: 20,
        leverage: 70, delayCost: 70, status: 'todo',
        createdAt: new Date(now - 86400000).toISOString(),
        updatedAt: new Date(now - 86400000).toISOString(),
      },
    ]

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'actions'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        for (const item of opportunities) tx.objectStore('opportunities').put(item)
        for (const item of actions) tx.objectStore('actions').put(item)
      }
    })
  })
  await page.reload()

  await page.locator('.surface-nav').getByRole('button', { name: /机会|Opportunities/ }).click()
  await expect(page.getByRole('heading', { name: /哪些在推进|What is moving/ })).toBeVisible()

  const rows = page.locator('.opportunity-decision-row')
  await expect(rows.filter({ hasText: '推进科技' })).toBeVisible()
  await expect(rows.filter({ hasText: '值得科技' })).toHaveCount(0)
  await expect(rows.filter({ hasText: '结束科技' })).toHaveCount(0)
  await expect(page.getByText(/Fit 88|Value 90|机会价值 90/)).toHaveCount(0)

  await page.getByRole('button', { name: /值得推进|Worth Pursuing/ }).click()
  const worthRow = rows.filter({ hasText: '值得科技' })
  await expect(worthRow).toBeVisible()
  await expect(worthRow).toContainText(/提交值得科技产品经理申请/)
  await expect(worthRow).toContainText(/申请截止|Application deadline/)

  await page.locator('.opportunity-decision-filter select').selectOption('ended')
  const endedRow = rows.filter({ hasText: '结束科技' })
  await expect(endedRow).toBeVisible()
  await expect(endedRow).not.toContainText('过期的结束流程待办')
  await page.screenshot({ path: testInfo.outputPath('cgr03-ended-list.png'), fullPage: true })
  await endedRow.click()
  const endedDetail = page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })
  await endedDetail.locator('.opportunity-detail-section').filter({ hasText: /准备与相关待办|Preparation & related actions/ }).locator('summary').click()
  await expect(endedDetail).toContainText('旧待办不会继续推荐；原记录仍保留')
  await expect(endedDetail.getByRole('button', { name: /标记完成|Mark done/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('cgr03-ended-detail.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(rows.filter({ hasText: '值得科技' })).toHaveCount(0)

  await page.locator('.opportunity-decision-filter select').selectOption('worth_pursuing')
  await worthRow.click()

  const dialog = page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })
  await expect(dialog).toBeVisible()
  const closeDetail = dialog.getByRole('button', { name: /关闭|Close/ })
  await expect(closeDetail).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => dialog.locator('.opportunity-detail-footer').evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Tab')
  await expect(closeDetail).toBeFocused()
  await expect(dialog.locator('.opportunity-detail-conclusion')).toContainText(/值得继续考虑|Worth pursuing/)
  await expect(dialog.locator('.opportunity-detail-process-summary')).toContainText(/待投|Not applied/)
  await expect(dialog.locator('.opportunity-detail-primary-operation')).toContainText('提交值得科技产品经理申请')
  await expect(dialog.locator('.opportunity-detail-nearest-node')).toContainText(/申请截止|Application deadline/)
  await expect(dialog.locator('.opportunity-detail-score-grid')).toHaveCount(0)

  const order = await dialog.evaluate((element) => {
    const selectors = [
      '.opportunity-detail-conclusion',
      '.opportunity-detail-process-summary',
      '.opportunity-detail-primary-operation',
      '.opportunity-detail-nearest-node',
    ]
    return selectors.map((selector) => element.querySelector(selector)?.getBoundingClientRect().top ?? -1)
  })
  expect(order[0]).toBeLessThan(order[1])
  expect(order[1]).toBeLessThan(order[2])
  expect(order[2]).toBeLessThan(order[3])

  await page.keyboard.press('Escape')
  await expect(worthRow).toBeFocused()
  const search = page.getByRole('textbox', { name: /搜索公司或岗位|Search company or role/ })
  await search.fill('值得')
  await page.locator('.surface-nav').getByRole('button', { name: /今天|Today/ }).click()
  await page.goBack()
  await expect(search).toHaveValue('值得')
  await expect(page.locator('.opportunity-decision-filter select')).toHaveValue('worth_pursuing')
  await expect(worthRow).toBeVisible()
  await worthRow.click()
  await page.goBack()
  await expect(worthRow).toBeFocused()
})

for (const fixture of [
  { timezone: 'Asia/Shanghai', now: '2026-09-21T04:00:00Z' },
  { timezone: 'America/Los_Angeles', now: '2026-09-22T00:30:00Z' },
]) {
  test.describe(`date-only deadline in ${fixture.timezone}`, () => {
    test.use({ timezoneId: fixture.timezone })
    test('keeps today visible and the detail conclusion open', async ({ page }) => {
      await page.clock.setFixedTime(new Date(fixture.now))
      await page.goto('/')
      await page.evaluate(async () => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('pjsdas', 11)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction(['opportunities'], 'readwrite')
            tx.onerror = () => reject(tx.error)
            tx.oncomplete = () => { db.close(); resolve() }
            tx.objectStore('opportunities').put({
              id: 'uu05-date-only', company: 'Calendar Fixture', role: 'Date-only role',
              currentStageLabel: '待投递', processStage: 'not_applied', roleType: 'core',
              participationStatus: 'active', early: false,
              deadline: '2026-09-21', deadlinePrecision: 'date',
              opportunityValue: 80, fitScore: 80, importedAt: '2026-09-01T00:00:00Z',
            })
          }
        })
      })
      await page.reload()
      await page.locator('.surface-nav').getByRole('button', { name: /机会|Opportunities/ }).click()
      await page.getByRole('button', { name: /值得推进|Worth Pursuing/ }).click()
      const row = page.locator('.opportunity-decision-row').filter({ hasText: 'Calendar Fixture' })
      await expect(row).toBeVisible()
      await row.click()
      const dialog = page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })
      await expect(dialog.locator('.opportunity-detail-conclusion')).toContainText(/值得继续考虑|Worth pursuing/)
      await expect(dialog.locator('.opportunity-detail-conclusion')).not.toContainText(/已截止|closed/i)
    })
  })
}
