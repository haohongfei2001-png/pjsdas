import { expect, test, type Page } from '@playwright/test'

const opportunity = {
  id: 'e2e-recovery-opportunity',
  company: '恢复测试科技',
  role: 'AI产品经理',
  currentStageLabel: '待投递',
  processStage: 'not_applied',
  roleType: 'core',
  early: false,
  opportunityValue: 88,
  fitScore: 84,
  deadline: '2026-09-20T23:59:59.000Z',
  locallyManaged: true,
  importedAt: '2026-09-14T00:00:00.000Z',
}

const action = {
  id: 'e2e-recovery-action',
  kind: 'apply',
  title: '提交恢复测试科技 AI 产品经理申请',
  opportunityId: opportunity.id,
  estimatedMinutes: 30,
  leverage: 80,
  delayCost: 90,
  dueAt: '2026-09-20T23:59:59.000Z',
  processStage: 'not_applied',
  status: 'todo',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
}

async function seedWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天只处理下一步' })).toBeVisible()

  await page.evaluate(async ({ opportunity, action }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'actions'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').put(opportunity)
        transaction.objectStore('actions').put(action)
      }
    })
  }, { opportunity, action })

  await page.reload()
  await expect(page.getByRole('heading', { name: action.title })).toBeVisible()
}

async function clearCoreWorkspace(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'processes', 'processEvents', 'actions', 'prep'], 'readwrite')
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.objectStore('opportunities').clear()
        transaction.objectStore('processes').clear()
        transaction.objectStore('processEvents').clear()
        transaction.objectStore('actions').clear()
        transaction.objectStore('prep').clear()
      }
    })
  })
}

async function readProcessState(page: Page) {
  return page.evaluate(async () => {
    return new Promise<{
      events: Array<{ id: string; opportunityId?: string; type: string; source: string; dueAt?: string }>
      actions: Array<{ id: string; opportunityId?: string; processEventId?: string; status: string; dueAt?: string }>
    }>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['processEvents', 'actions'], 'readonly')
        const eventsRequest = transaction.objectStore('processEvents').getAll()
        const actionsRequest = transaction.objectStore('actions').getAll()
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          const events = eventsRequest.result as Array<{ id: string; opportunityId?: string; type: string; source: string; dueAt?: string }>
          const actions = actionsRequest.result as Array<{ id: string; opportunityId?: string; processEventId?: string; status: string; dueAt?: string }>
          db.close()
          resolve({ events, actions })
        }
      }
    })
  })
}

async function readCoreState(page: Page) {
  return page.evaluate(async () => {
    return new Promise<{ opportunityIds: string[]; actionIds: string[] }>((resolve, reject) => {
      const request = indexedDB.open('pjsdas', 8)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction(['opportunities', 'actions'], 'readonly')
        const opportunitiesRequest = transaction.objectStore('opportunities').getAll()
        const actionsRequest = transaction.objectStore('actions').getAll()
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => {
          const opportunities = opportunitiesRequest.result as Array<{ id: string }>
          const actions = actionsRequest.result as Array<{ id: string }>
          db.close()
          resolve({
            opportunityIds: opportunities.map((item) => item.id),
            actionIds: actions.map((item) => item.id),
          })
        }
      }
    })
  })
}

async function openBackup(page: Page) {
  await page.locator('.surface-nav').getByRole('button', { name: /设置/ }).click()
  await expect(page.getByRole('heading', { name: '连接、自动化和长期控制' })).toBeVisible()
  await page.locator('details.settings-group').filter({ hasText: '数据与恢复' }).locator('summary').click()
  await page.getByRole('button', { name: '本地备份' }).click()
  await expect(page.getByRole('heading', { name: '备份与恢复' })).toBeVisible()
}

test('manual recruiting event creates one durable event/action, survives reload, and deletes cleanly', async ({ page }) => {
  await seedWorkspace(page)

  await page.locator('.today-manual-fallback > summary').click()
  await page.getByRole('button', { name: '+ 记录流程通知' }).click()
  await expect(page.getByRole('heading', { name: '记录真实流程通知' })).toBeVisible()

  await page.locator('input[list="process-event-opportunities"]').fill(`${opportunity.company}｜${opportunity.role} [${opportunity.id}]`)
  await page.locator('.event-form select').first().selectOption('assessment_invite')
  const dateInputs = page.locator('.event-form input[type="datetime-local"]')
  await dateInputs.nth(0).fill('2026-09-14T10:00')
  await dateInputs.nth(1).fill('2026-09-18T20:00')
  await page.getByRole('button', { name: '保存事件' }).click()

  const historyItem = page.locator('.event-history-item').filter({ hasText: opportunity.company })
  await expect(historyItem).toHaveCount(1)

  const created = await readProcessState(page)
  expect(created.events).toHaveLength(1)
  expect(created.events[0]).toMatchObject({
    opportunityId: opportunity.id,
    type: 'assessment_invite',
    source: 'manual',
  })
  expect(created.events[0]!.dueAt).toBeTruthy()
  const linkedAction = created.actions.find((item) => item.processEventId === created.events[0]!.id)
  expect(linkedAction).toMatchObject({
    opportunityId: opportunity.id,
    status: 'todo',
    dueAt: created.events[0]!.dueAt,
  })

  const eventId = created.events[0]!.id
  await page.getByRole('button', { name: '关闭' }).click()
  await page.reload()

  const afterReload = await readProcessState(page)
  expect(afterReload.events.map((item) => item.id)).toContain(eventId)
  expect(afterReload.actions.some((item) => item.processEventId === eventId)).toBe(true)

  await page.getByRole('button', { name: '+ 记录流程通知' }).click()
  const persistedHistoryItem = page.locator('.event-history-item').filter({ hasText: opportunity.company })
  await expect(persistedHistoryItem).toHaveCount(1)
  await persistedHistoryItem.getByRole('button', { name: '删除' }).click()
  await expect(persistedHistoryItem).toHaveCount(0)

  const afterDelete = await readProcessState(page)
  expect(afterDelete.events.some((item) => item.id === eventId)).toBe(false)
  expect(afterDelete.actions.some((item) => item.processEventId === eventId)).toBe(false)
  expect(afterDelete.actions.map((item) => item.id)).toContain(action.id)
})

test('JSON backup restores a deliberately cleared local workspace and remains durable after reload', async ({ page }) => {
  await seedWorkspace(page)
  await openBackup(page)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON 备份' }).click()
  const download = await downloadPromise
  const backupPath = await download.path()
  expect(backupPath).toBeTruthy()
  await expect(page.locator('.backup-notice.success')).toContainText('已导出')

  await page.locator('.backup-dialog').getByRole('button', { name: '关闭' }).click()
  await clearCoreWorkspace(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: '先让工作区有第一批真实机会' })).toBeVisible()

  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByRole('heading', { name: '连接、自动化和长期控制' })).toBeVisible()
  await page.locator('details.settings-group').filter({ hasText: '数据与恢复' }).locator('summary').click()
  await page.getByRole('button', { name: '本地备份' }).click()
  await page.locator('.backup-file-button input[type="file"]').setInputFiles(backupPath!)
  await expect(page.locator('.backup-preview')).toContainText('岗位 1')
  await expect(page.locator('.backup-preview')).toContainText('Action 1')

  await page.getByRole('button', { name: '确认恢复' }).click()
  await expect(page.locator('.backup-notice.success')).toContainText('已恢复')
  const restored = await readCoreState(page)
  expect(restored.opportunityIds).toContain(opportunity.id)
  expect(restored.actionIds).toContain(action.id)

  await page.locator('.backup-dialog').getByRole('button', { name: '关闭' }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /今天/ }).click()
  await expect(page.getByRole('heading', { name: action.title })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: action.title })).toBeVisible()
})

test('invalid backup is rejected before restore and leaves the current workspace untouched', async ({ page }) => {
  await seedWorkspace(page)
  await openBackup(page)

  await page.locator('.backup-file-button input[type="file"]').setInputFiles({
    name: 'invalid-pjsdas-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 999, data: { opportunities: [] } })),
  })

  await expect(page.locator('.backup-notice.error')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认恢复' })).toHaveCount(0)

  const state = await readCoreState(page)
  expect(state.opportunityIds).toContain(opportunity.id)
  expect(state.actionIds).toContain(action.id)

  await page.locator('.backup-dialog').getByRole('button', { name: '关闭' }).click()
  await page.locator('.surface-nav').getByRole('button', { name: /今天/ }).click()
  await expect(page.getByRole('heading', { name: action.title })).toBeVisible()
})
