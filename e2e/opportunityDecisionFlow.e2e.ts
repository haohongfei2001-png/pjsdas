import { expect, test } from '@playwright/test'

test('UU-05 Opportunities centers In Progress / Worth Pursuing and opens conclusion-first detail', async ({ page }) => {
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
    ]

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 10)
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
  await expect(rows.filter({ hasText: '结束科技' })).toBeVisible()
  await expect(rows.filter({ hasText: '值得科技' })).toHaveCount(0)

  await page.locator('.opportunity-decision-filter select').selectOption('worth_pursuing')
  await worthRow.click()

  const dialog = page.getByRole('dialog', { name: /岗位详情|Opportunity details/ })
  await expect(dialog).toBeVisible()
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
})
