import { expect, test } from '@playwright/test'

test('UU-04 shell keeps exactly three primary destinations keyboard-accessible and routes Settings outside primary nav', async ({ page }) => {
  await page.goto('/')

  const main = page.locator('main.surface-main')
  const nav = page.locator('.tsui-primary-nav')
  await expect(main).toBeVisible()
  await expect(nav).toBeVisible()

  const navButtons = nav.getByRole('button')
  await expect(navButtons).toHaveCount(3)
  await expect(navButtons.nth(0)).toContainText(/今天|Today/)
  await expect(navButtons.nth(1)).toContainText(/岗位库|Jobs/)
  await expect(navButtons.nth(2)).toContainText(/日程|Schedule/)

  for (let index = 0; index < 3; index += 1) {
    const button = navButtons.nth(index)
    await expect(button).toBeVisible()
    await button.focus()
    await expect(button).toBeFocused()
  }

  await expect(page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ })).toBeVisible()
  await expect(nav.getByRole('button', { name: /设置|Settings/ })).toHaveCount(0)

  await page.locator('.tsui-topbar').getByRole('button', { name: /设置|Settings/ }).click()
  const dataRecovery = page.locator('details.settings-group > summary').filter({ hasText: /数据与恢复|Data & recovery/ })
  await dataRecovery.focus()
  await expect(dataRecovery).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dataRecovery.locator('..')).toHaveAttribute('open', '')

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewport + 2)
})

test('390x844 switches between the task and upcoming node without horizontal clipping', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  await page.evaluate(async () => {
    const now = Date.now()
    const opportunity = {
      id: 'mobile-gate-opportunity',
      company: '移动端科技',
      role: '产品经理',
      currentStageLabel: '面试',
      processStage: 'interview',
      roleType: 'core',
      early: false,
      opportunityValue: 86,
      fitScore: 82,
      locallyManaged: true,
      importedAt: new Date(now).toISOString(),
    }
    const action = {
      id: 'mobile-gate-action',
      kind: 'manual',
      title: '准备移动端面试材料',
      opportunityId: opportunity.id,
      estimatedMinutes: 20,
      leverage: 96,
      delayCost: 90,
      status: 'todo',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    const event = {
      id: 'mobile-gate-interview',
      opportunityId: opportunity.id,
      company: opportunity.company,
      role: opportunity.role,
      type: 'interview_invite',
      occurredAt: new Date(now).toISOString(),
      dueAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      duePrecision: 'datetime',
      timingMode: 'fixed',
      estimatedMinutes: 60,
      source: 'manual',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 11)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['opportunities', 'actions', 'processEvents'], 'readwrite')
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.objectStore('opportunities').put(opportunity)
        tx.objectStore('actions').put(action)
        tx.objectStore('processEvents').put(event)
      }
    })
  })

  await page.reload()
  const primary = page.locator('.tsui-task-row').first()
  const node = page.locator('.tsui-node-row').filter({ hasText: '移动端科技' }).first()
  await expect(primary.getByRole('heading', { name: '准备移动端面试材料' })).toBeVisible()
  await expect(page.locator('.tsui-node-panel')).toBeHidden()
  await expect(page.locator('.tsui-primary-nav').getByRole('button')).toHaveCount(3)
  await expect(page.locator('.tsui-tell-button')).toBeVisible()

  const boxes = await Promise.all([primary.boundingBox()])
  for (const box of boxes) {
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(844)
  }

  await page.getByRole('button', { name: /节点/ }).first().click()
  await expect(node).toBeVisible()
  const nodeBox = await node.boundingBox()
  expect(nodeBox).not.toBeNull()
  expect(nodeBox!.y).toBeGreaterThanOrEqual(0)
  expect(nodeBox!.y + nodeBox!.height).toBeLessThanOrEqual(844)

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewport + 2)
})
